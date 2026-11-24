//! Sandbox enforcement backend abstraction (Track R2, P1).
//!
//! Tách `spawn_sandboxed` monolithic (lib.rs) thành pipeline qua trait
//! [`SandboxBackend`]: policy/precheck giữ ở lib, enforcement (argv shaping,
//! pre-exec hook, process containment) đi qua backend. Napi surface không đổi.
//!
//! Hợp đồng lỗi theo mẫu AgentEnv `SandboxCaptureError::{Recoverable,
//! Terminal}` (deep-dive `agentenv/02`, backend.rs:49-69/172):
//! - [`SandboxError::Recoverable`] — môi trường còn nguyên, caller có thể
//!   retry lệnh (spawn OS error, hệ thống không bị mutate).
//! - [`SandboxError::Terminal`] — containment đã bị mutate, đứa con phải bị
//!   bỏ (kill) — ví dụ gán Job Object thất bại khi child đang CREATE_SUSPENDED.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::{Enforcement, SandboxOptions, SandboxViolation};

/// Pre-exec enforcement hook (landlock `restrict_writes` trên linux).
///
/// `Sync` là bắt buộc: `std::os::unix::process::CommandExt::pre_exec` nhận
/// `FnMut() -> io::Result<()> + Send + Sync` (closure chạy trong child sau
/// fork, trước exec — an toàn khi chia sẻ giữa các thread). Thiếu `Sync` chỉ
/// nổ trên unix, không hiện trên windows.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) type PreExecHook = Box<dyn FnMut() -> std::io::Result<()> + Send + Sync>;

/// argv/env/cwd sau khi backend shape (seatbelt wrap trên macOS, env scrub).
pub(crate) struct PreparedCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[cfg_attr(not(unix), allow(dead_code))] // linux pipeline phân loại spawn error
pub(crate) enum SandboxError {
    /// Môi trường còn nguyên — lệnh có thể được retry.
    Recoverable {
        reason: &'static str,
        detail: String,
    },
    /// Containment đã mutate — caller phải discard đứa con (kill).
    #[allow(dead_code)] // P3 dùng cho job-assign-failure khi child suspended
    Terminal {
        reason: &'static str,
        detail: String,
    },
}

#[cfg_attr(not(unix), allow(dead_code))]
impl SandboxError {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            SandboxError::Recoverable { reason, .. } => reason,
            SandboxError::Terminal { reason, .. } => reason,
        }
    }

    pub(crate) fn detail(&self) -> &str {
        match self {
            SandboxError::Recoverable { detail, .. } => detail,
            SandboxError::Terminal { detail, .. } => detail,
        }
    }
}

/// Runtime containment cho một child đã spawn (Job Object trên Windows).
/// Giữ handle sống đến khi child được reap (kill-on-close).
pub(crate) trait Containment {
    /// Kích hoạt containment sau khi gán (resume child suspended).
    /// Default: no-op (child không bao giờ ở trạng thái suspended).
    fn activate(&mut self, _child: &mut std::process::Child) -> std::io::Result<()> {
        Ok(())
    }

    /// Poll định kỳ trong wait loop; trả violation khi vượt limit (IO budget),
    /// caller sẽ kill child. Default: None (không poll gì).
    fn poll(&mut self) -> Option<SandboxViolation> {
        None
    }

    /// Kill toàn bộ process tree (TerminateJobObject trên Windows) — quan
    /// trọng vì tiến trình cháu kế thừa stdout/stderr pipe: kill chỉ process
    /// gốc khiến wait_with_output chờ drain cho tới khi cháu exit. Trả false
    /// khi backend không hỗ trợ — caller dùng child.kill() thay thế.
    fn terminate_tree(&mut self) -> bool {
        false
    }
}

/// Backend enforcement: chuẩn bị argv/env/cwd, hook pre-exec và contain child.
pub(crate) trait SandboxBackend {
    /// Enforcement tier backend này sẽ thực thi.
    fn enforcement(&self) -> Enforcement;

    /// Shape argv (seatbelt wrap trên macOS), scrub env, chọn cwd.
    fn prepare(
        &self,
        program: &str,
        args: &[String],
        opts: &SandboxOptions,
        enforcement: Enforcement,
        writable_extra: &[PathBuf],
    ) -> PreparedCommand;

    /// Enforcement chạy trong child trước `exec` (landlock). `None` khi N/A.
    ///
    /// `writable_extra`: root ghi được CỘNG THÊM vào profile default. Overlay
    /// session truyền cwd của child (`upper/`) vào đây — trên linux child phải
    /// ghi được vào `upper/` vì ĐÓ chính là vùng containment; thiếu nó thì
    /// profile Strict chặn luôn cả write hợp lệ và `overlay_commit` promote
    /// một thư mục rỗng (bug lộ ra khi unix compile được).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn pre_exec_hook(
        &self,
        _opts: &SandboxOptions,
        _enforcement: Enforcement,
        _writable_extra: &[PathBuf],
    ) -> Option<PreExecHook> {
        None
    }

    /// Creation flags bổ sung (Windows: CREATE_SUSPENDED để gán Job Object
    /// TRƯỚC khi resume — vá race job-gán-sau-spawn của v1).
    fn creation_flags(&self) -> u32 {
        0
    }

    /// Contain đứa con vừa spawn (Job Object trên Windows). `Ok(None)` =
    /// không có containment trên platform này; `Err(Terminal)` = containment
    /// mutate — caller phải kill đứa con (child đang suspended thì bắt buộc).
    fn contain(
        &self,
        child: &std::process::Child,
        opts: &SandboxOptions,
    ) -> Result<Option<Box<dyn Containment>>, SandboxError>;
}

/// Backend production duy nhất hiện nay: đường supervised — mọi platform đều
/// chạy supervised core (env scrub + precheck ở lib), enforcement OS-level
/// tùy platform (landlock / seatbelt / Job Object Windows).
pub(crate) struct SupervisedBackend;

impl SandboxBackend for SupervisedBackend {
    fn enforcement(&self) -> Enforcement {
        crate::detect_enforcement()
    }

    fn prepare(
        &self,
        program: &str,
        args: &[String],
        opts: &SandboxOptions,
        enforcement: Enforcement,
        writable_extra: &[PathBuf],
    ) -> PreparedCommand {
        #[cfg(not(target_os = "macos"))]
        let _ = (enforcement, writable_extra);
        // macOS: bọc argv trong `sandbox-exec -p <SBPL>` cho Seatbelt.
        #[cfg(target_os = "macos")]
        let (argv_program, argv_args): (String, Vec<String>) =
            if enforcement == Enforcement::Seatbelt {
                (
                    "/usr/bin/sandbox-exec".into(),
                    [
                        "-p".to_string(),
                        crate::seatbelt_profile(opts, writable_extra),
                        "--".to_string(),
                        program.to_string(),
                    ]
                    .into_iter()
                    .chain(args.iter().cloned())
                    .collect(),
                )
            } else {
                (program.to_string(), args.to_vec())
            };
        #[cfg(not(target_os = "macos"))]
        let (argv_program, argv_args): (String, Vec<String>) = (program.to_string(), args.to_vec());

        PreparedCommand {
            program: argv_program,
            args: argv_args,
            env: crate::scrub_env(&opts.env_allow),
            cwd: opts.workspace.clone(),
        }
    }

    #[cfg(target_os = "linux")]
    fn pre_exec_hook(
        &self,
        opts: &SandboxOptions,
        enforcement: Enforcement,
        writable_extra: &[PathBuf],
    ) -> Option<PreExecHook> {
        if enforcement != Enforcement::Landlock {
            return None;
        }
        let mut write_roots: Vec<PathBuf> = match opts.profile {
            crate::SandboxProfile::Workspace => {
                vec![opts.workspace.clone(), std::env::temp_dir()]
            }
            crate::SandboxProfile::ReadOnly | crate::SandboxProfile::Strict => vec![],
        };
        // Overlay cwd (`upper/`) là vùng containment của child — phải ghi được,
        // nếu không profile Strict vô hiệu hóa chính cơ chế cách ly của nó.
        write_roots.extend(writable_extra.iter().cloned());
        Some(Box::new(move || {
            crate::landlock::restrict_writes(&write_roots)
        }))
    }

    #[cfg(target_os = "windows")]
    fn creation_flags(&self) -> u32 {
        // Spawn suspended → job gán khi process chưa chạy dòng nào → hết cửa
        // sổ escape; resume ngay sau khi gán (Containment::activate).
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        CREATE_SUSPENDED
    }

    #[cfg(target_os = "windows")]
    fn contain(
        &self,
        child: &std::process::Child,
        opts: &SandboxOptions,
    ) -> Result<Option<Box<dyn Containment>>, SandboxError> {
        // Windows: contain child tree trong kill-on-close Job Object với
        // limits. Thất bại = Terminal (child suspended phải bị discard).
        crate::win_job::JobGuard::assign(child, opts)
            .map(|guard| Some(Box::new(guard) as Box<dyn Containment>))
            .map_err(|detail| SandboxError::Terminal {
                reason: "job-assign",
                detail,
            })
    }

    #[cfg(not(target_os = "windows"))]
    fn contain(
        &self,
        _child: &std::process::Child,
        _opts: &SandboxOptions,
    ) -> Result<Option<Box<dyn Containment>>, SandboxError> {
        Ok(None)
    }
}
