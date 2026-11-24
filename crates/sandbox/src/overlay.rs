//! Overlay-dir rollback cho ReadOnly/Strict profiles (Track R2, P2).
//!
//! Windows v1 vẫn KHÔNG có minifilter/ACL provisioning — 3 blocker upstream
//! trong `windows.rs` giữ nguyên làm boundary (tokio-tungstenite fork, rama
//! pin theo codex Cargo.lock, codex-utils-pty trên windows-GNU). Write
//! containment path-level do đó được thay bằng overlay session:
//!
//! - Child chạy với cwd = `<session>/upper/` → mọi write tương đối đổ vào
//!   `upper/`, không chạm workspace thật.
//! - `upper/base` là junction (Windows) / symlink (unix) trỏ về workspace →
//!   đường đọc workspace vẫn mở (`base/...`), không copy dữ liệu.
//! - TEMP/TMP/TMPDIR bị redirect vào `upper/temp` qua env (scrub cho phép
//!   các var này) — scratch writes của toolchain cũng nằm trong upper.
//! - **rollback** = xóa cả session dir (mặc định cho ReadOnly/Strict).
//! - **commit** = merge `upper/` (trừ junction `base`) về workspace rồi xóa
//!   session — chỉ khi caller chủ động bật `SandboxOptions::overlay_commit`.
//!
//! Giới hạn đã ghi nhận (giống research §6b): process ghi file bằng đường
//! tuyệt đối ngoài workspace vẫn lọt — chỉ giải quyết triệt để khi codex
//! sandbox provisioning (3 blocker) hoặc ACL deny-write được integrate.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::SandboxProfile;

/// Môi trường overlay cho MỘT lần chạy sandbox.
#[derive(Debug)]
pub(crate) struct OverlaySession {
    /// Session root — chứa toàn bộ upper; rollback = remove_dir_all(root).
    root: PathBuf,
    /// Thư mục write của child (= cwd của child).
    upper: PathBuf,
    /// `upper/temp` — TEMP/TMP/TMPDIR redirect (scratch, không commit).
    temp: PathBuf,
    /// `upper/base` — junction/symlink về workspace (đường đọc).
    base_link: PathBuf,
    /// Workspace thật (commit target).
    workspace: PathBuf,
}

impl OverlaySession {
    /// Tạo overlay cho ReadOnly/Strict; `Workspace` không cần overlay → None.
    /// Workspace phải tồn tại (giữ hành vi spawn-failed của v1 khi thiếu cwd).
    pub fn create(profile: SandboxProfile, workspace: &Path) -> io::Result<Option<Self>> {
        if profile == SandboxProfile::Workspace {
            return Ok(None);
        }
        if !workspace.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "overlay requires an existing workspace: {}",
                    workspace.display()
                ),
            ));
        }

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "ghita-sandbox-overlay-{}-{nanos}",
            std::process::id()
        ));
        let upper = root.join("upper");
        let temp = upper.join("temp");
        std::fs::create_dir_all(&temp)?;

        let base_link = upper.join("base");
        link_workspace(&base_link, workspace)?;

        Ok(Some(Self {
            root,
            upper,
            temp,
            base_link,
            workspace: workspace.to_path_buf(),
        }))
    }

    /// cwd cho child — mọi write tương đối nằm trong upper.
    pub fn cwd(&self) -> &Path {
        &self.upper
    }

    /// Env overrides áp lên env đã scrub: TEMP trỏ vào upper, base/overlay
    /// path expose qua biến GHITA_SANDBOX_* cho process biết đường đọc.
    pub fn env_overrides(&self) -> Vec<(String, String)> {
        vec![
            (
                "TMP".into(),
                self.upper.join("temp").to_string_lossy().into(),
            ),
            (
                "TEMP".into(),
                self.upper.join("temp").to_string_lossy().into(),
            ),
            (
                "TMPDIR".into(),
                self.upper.join("temp").to_string_lossy().into(),
            ),
            (
                "GHITA_SANDBOX_OVERLAY".into(),
                self.upper.to_string_lossy().into(),
            ),
            (
                "GHITA_SANDBOX_BASE".into(),
                self.workspace.to_string_lossy().into(),
            ),
        ]
    }

    /// Hủy toàn bộ write của child: xóa session dir (junction `base` bị bỏ
    /// link, KHÔNG đụng workspace thật — std remove_dir_all không theo
    /// reparse point sau bản fix CVE-2022-21658).
    pub fn rollback(self) -> io::Result<()> {
        std::fs::remove_dir_all(&self.root)
    }

    /// Promote write của child về workspace: merge `upper/` (trừ junction
    /// `base` và thư mục temp scratch) rồi xóa session dir.
    pub fn commit(self) -> io::Result<()> {
        let skip: Vec<&Path> = vec![&self.base_link, &self.temp];
        merge_dir(&self.upper, &self.workspace, &skip)?;
        std::fs::remove_dir_all(&self.root)
    }
}

/// Tạo junction (Windows, không cần quyền admin — `mklink /J`) hoặc symlink
/// (unix) `link` → `workspace`.
fn link_workspace(link: &Path, workspace: &Path) -> io::Result<()> {
    let target = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());

    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            // Không junction được → bỏ qua đường đọc tương đối (đường tuyệt
            // đối vẫn hoạt động); overlay vẫn kín write.
            return Ok(());
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, link).or(Ok(()))
        }
        #[cfg(not(unix))]
        {
            let _ = (link, target);
            Ok(())
        }
    }
}

/// Merge đệ quy `src` → `dst`, bỏ qua các path trong `skip` (junction `base`,
/// thư mục `temp` scratch). Copy qua volume (rename fail → copy + remove).
///
/// Reparse point (symlink/junction) do child tạo trong upper KHÔNG được
/// merge: `file_type()` (không theo link) nhận diện symlink/junction → bỏ
/// qua, chống dereference trỏ tới thư mục tùy ý ngoài upper khi commit
/// (junction không cần quyền — child tạo được).
fn merge_dir(src: &Path, dst: &Path, skip: &[&Path]) -> io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        if skip.iter().any(|s| path == *s) {
            continue;
        }
        // file_type() đọc reparse point KHÔNG theo link (metadata() thì có).
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            std::fs::create_dir_all(&target)?;
            merge_dir(&path, &target, skip)?;
        } else if std::fs::rename(&path, &target).is_err() {
            std::fs::copy(&path, &target)?;
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("ghita-overlay-test-{label}-{nanos}"))
    }

    #[test]
    fn workspace_profile_gets_no_overlay() {
        let ws = unique_dir("ws-none");
        std::fs::create_dir_all(&ws).unwrap();
        let session = OverlaySession::create(SandboxProfile::Workspace, &ws).unwrap();
        assert!(session.is_none());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn missing_workspace_is_an_overlay_error() {
        let missing = unique_dir("missing");
        let err = OverlaySession::create(SandboxProfile::ReadOnly, &missing).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn base_link_exposes_workspace_reads() {
        let ws = unique_dir("ws-link");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("readme.txt"), "hello overlay").unwrap();

        let session = OverlaySession::create(SandboxProfile::Strict, &ws)
            .unwrap()
            .expect("strict gets overlay");
        let via_link = session.cwd().join("base").join("readme.txt");
        let content =
            std::fs::read_to_string(&via_link).expect("workspace readable through base link");
        assert_eq!(content, "hello overlay");

        // Write tương đối đổ vào upper, không chạm workspace.
        std::fs::write(session.cwd().join("scratch.txt"), "dirty").unwrap();
        assert!(!ws.join("scratch.txt").exists());
        // Scratch trong upper/temp không được commit (đúng hợp đồng merge).
        std::fs::write(session.cwd().join("temp").join("cache.tmp"), "x").unwrap();

        // Commit: merge upper về workspace (junction `base` bị skip).
        session.commit().unwrap();
        assert_eq!(
            std::fs::read_to_string(ws.join("scratch.txt")).unwrap(),
            "dirty"
        );
        assert!(
            !ws.join("base").exists(),
            "junction must not be merged back"
        );
        assert!(
            !ws.join("temp").exists(),
            "temp scratch must not be committed"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn rollback_discards_upper_writes_and_keeps_base() {
        let ws = unique_dir("ws-rollback");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("keep.txt"), "keep").unwrap();

        let session = OverlaySession::create(SandboxProfile::Strict, &ws)
            .unwrap()
            .expect("strict gets overlay");
        std::fs::write(session.cwd().join("forbidden.txt"), "x").unwrap();
        assert!(!ws.join("forbidden.txt").exists());

        session.rollback().unwrap();
        assert!(!ws.join("forbidden.txt").exists());
        assert_eq!(
            std::fs::read_to_string(ws.join("keep.txt")).unwrap(),
            "keep",
            "workspace content untouched by rollback"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }
}
