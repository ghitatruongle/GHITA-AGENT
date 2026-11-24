//! Ghita Agent — Windows PTY helpers (Track R2/R1)
//!
//! Patterns ported from node-pty (`src/win/conpty_console_list.cc`,
//! `windowsPtyAgent.ts argsToCommandLine` — winpty origin) as documented in
//! `docs/plans/0.0.2-alpha/deep-dive/node-pty/02-luot-2-kien-truc-thuat-toan.md`:
//!
//! - **Kill-tree console-aware**: `FreeConsole → AttachConsole(child) →
//!   GetConsoleProcessList → TerminateProcess` each attached process.
//!   GetConsoleProcessList follows the *console* relation (not the parent/child
//!   tree) — still correct when grandchildren spawn detached but stay on the
//!   console, or when the parent/child tree broke after the parent died.
//!   Must run BEFORE the ConPTY master is closed (the console dies with it).
//! - **PID-reuse race guards** (upstream node-pty has an unfixed variant of
//!   this race — commit 271faf3 fixed it, fae2ee9 reverted it):
//!   1. *Attach guard*: the recorded creation time of the child (queried right
//!      after spawn) must still match the creation time of the process that
//!      currently owns `child_pid`; otherwise the pid was reused and we must
//!      not attach to (and later massacre) an unrelated console.
//!   2. *Kill guard*: a candidate from the console list is only terminated if
//!      its creation time predates the start of our kill operation. Anything
//!      created after `kill_started` is either a pid-reuse impostor or a
//!      freshly spawned child racing the kill — skipping it is the safe side
//!      of the trade-off (console teardown reaps console clients anyway).
//! - **Escape commandline** compatible with `CommandLineToArgvW` (MSDN rules),
//!   ported from node-pty's `argsToCommandLine` (winpty origin).

use std::sync::Mutex;

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{
    AttachConsole, FreeConsole, GetConsoleProcessList, GetConsoleWindow, ATTACH_PARENT_PROCESS,
};
use windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessTimes, OpenProcess, TerminateProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

/// One process may only be attached to one console at a time — the
/// FreeConsole/AttachConsole dance must therefore be atomic within this
/// process (concurrent kill_session calls race otherwise).
static CONSOLE_DANCE_LOCK: Mutex<()> = Mutex::new(());

/// Initial size of the GetConsoleProcessList buffer (node-pty parity:
/// `conpty_console_list.cc` starts at 64 and grows when the count overflows).
const CONSOLE_LIST_INITIAL: usize = 64;

// ---------------------------------------------------------------------------
// Kill-tree (console-aware, race-guarded)
// ---------------------------------------------------------------------------

/// Kill every process attached to the console of `child_pid` (except our own
/// process and `child_pid` itself — the direct child is terminated by the
/// caller through the live child handle, which is immune to pid reuse).
///
/// Returns the number of processes terminated. `recorded_start_time` is the
/// child's creation time captured at spawn time (`None` → skip entirely:
/// without the attach guard we refuse to run the dance at all).
pub fn kill_console_process_tree(child_pid: u32, recorded_start_time: Option<u64>) -> usize {
    // Attach guard: refuse to run when we could not verify that `child_pid`
    // still refers to the process we spawned.
    let Some(recorded) = recorded_start_time else {
        return 0;
    };
    if process_start_time_by_pid(child_pid) != Some(recorded) {
        // PID reused (child already dead) — fall back to the plain child kill.
        return 0;
    }

    // Capture BEFORE attaching: any console member created after this point
    // is a pid-reuse impostor (or a child spawned mid-kill) — skipped.
    let kill_started = now_filetime();

    let mut killed = 0usize;
    // Enumerate while attached; terminate after we restored our console so
    // the dance window stays as short as possible.
    let candidates = enumerate_console_processes(child_pid);

    for pid in candidates {
        // Never touch ourselves or the direct child.
        if pid == 0 || pid == child_pid || pid == unsafe { GetCurrentProcessId() } {
            continue;
        }
        if kill_pid_if_stale(pid, kill_started) {
            killed += 1;
        }
    }
    killed
}

/// Attach to the child's console, snapshot `GetConsoleProcessList`, restore
/// our own console. Returns an empty list when the attach fails (child dead /
/// no console — node-pty parity: empty list, only plain teardown remains).
fn enumerate_console_processes(child_pid: u32) -> Vec<u32> {
    // A poisoned lock (panic in a previous dance) must NOT disable the
    // mutual exclusion — `.lock().ok()` would drop the guard and let two
    // threads run the FreeConsole/AttachConsole dance concurrently.
    let _guard = CONSOLE_DANCE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let had_console = unsafe { !GetConsoleWindow().is_null() };

    unsafe {
        FreeConsole();
        if AttachConsole(child_pid) == 0 {
            // Attach failed — process already dead or console gone.
            restore_console(had_console);
            return Vec::new();
        }
        let mut pids: Vec<u32> = vec![0; CONSOLE_LIST_INITIAL];
        let mut count = GetConsoleProcessList(pids.as_mut_ptr(), CONSOLE_LIST_INITIAL as u32);
        if count as usize > CONSOLE_LIST_INITIAL {
            // Buffer too small — grow and re-query (node-pty parity).
            pids.resize(count as usize, 0);
            count = GetConsoleProcessList(pids.as_mut_ptr(), count);
        }
        FreeConsole();
        restore_console(had_console);
        if count == 0 || count as usize > pids.len() {
            return Vec::new();
        }
        pids.truncate(count as usize);
        pids
    }
}

/// Re-attach to the console we were on before the dance.
/// `ATTACH_PARENT_PROCESS` restores the console of our parent process — for
/// the Tauri app (no console in release) this is a harmless no-op failure;
/// for dev/test console hosts it recovers the original console.
fn restore_console(had_console: bool) {
    if had_console {
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

/// Open `pid` and terminate it — but only when its creation time predates
/// `kill_started` (the PID-reuse kill guard).
fn kill_pid_if_stale(pid: u32, kill_started: u64) -> bool {
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        );
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return false;
        }
        // Kill guard: skip processes created after we began the kill.
        let stale = match process_start_time_by_handle(handle) {
            Some(created) => created <= kill_started,
            // Cannot verify the start time → do not terminate (safe side).
            None => false,
        };
        let terminated = if stale {
            TerminateProcess(handle, 1) != 0
        } else {
            false
        };
        CloseHandle(handle);
        terminated
    }
}

// ---------------------------------------------------------------------------
// Process start times (PID-reuse guard primitive)
// ---------------------------------------------------------------------------

/// Creation time of the process currently owning `pid`, as a `u64` FILETIME.
/// `None` when the process cannot be opened (dead) or the time is unavailable.
pub fn process_start_time_by_pid(pid: u32) -> Option<u64> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let time = process_start_time_by_handle(handle);
        CloseHandle(handle);
        time
    }
}

/// Creation time of an already-open process handle.
fn process_start_time_by_handle(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    Some(filetime_to_u64(&creation))
}

/// Current system time as a `u64` FILETIME (comparable with process creation
/// times from `GetProcessTimes`).
pub fn now_filetime() -> u64 {
    let mut ft = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    unsafe {
        GetSystemTimeAsFileTime(&mut ft);
    }
    filetime_to_u64(&ft)
}

fn filetime_to_u64(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

// ---------------------------------------------------------------------------
// CommandLineToArgvW-compatible commandline escaping
// (port of node-pty `argsToCommandLine`, winpty origin)
// ---------------------------------------------------------------------------

/// Escape `program` + `args` into a single command line that
/// `CommandLineToArgvW` parses back into the same argv (MSDN "Argument
/// parsing" rules). Quote when the element is empty or contains a space/tab
/// and is not already fully quoted; double the backslashes that precede a
/// quote (`bs_count * 2 + 1`) and pair trailing backslashes of quoted
/// elements (`bs_count * 2`).
pub fn args_to_commandline(program: &str, args: &[String]) -> String {
    let mut argv: Vec<&str> = Vec::with_capacity(args.len() + 1);
    argv.push(program);
    argv.extend(args.iter().map(|s| s.as_str()));

    let mut result = String::new();
    for (arg_index, arg) in argv.iter().enumerate() {
        if arg_index > 0 {
            result.push(' ');
        }
        let first = arg.chars().next();
        let last = arg.chars().last();
        let has_lopsided_enclosing_quote = (first != Some('"')) != (last != Some('"'));
        let has_no_enclosing_quotes = first != Some('"') && last != Some('"');
        let quote = arg.is_empty()
            || ((arg.contains(' ') || arg.contains('\t'))
                && arg.chars().count() > 1
                && (has_lopsided_enclosing_quote || has_no_enclosing_quotes));
        if quote {
            result.push('"');
        }
        let mut bs_count: usize = 0;
        for p in arg.chars() {
            if p == '\\' {
                bs_count += 1;
            } else if p == '"' {
                for _ in 0..(bs_count * 2 + 1) {
                    result.push('\\');
                }
                result.push('"');
                bs_count = 0;
            } else {
                for _ in 0..bs_count {
                    result.push('\\');
                }
                bs_count = 0;
                result.push(p);
            }
        }
        if quote {
            for _ in 0..(bs_count * 2) {
                result.push('\\');
            }
            result.push('"');
        } else {
            for _ in 0..bs_count {
                result.push('\\');
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_args_to_commandline_simple() {
        assert_eq!(args_to_commandline("cmd.exe", &[]), "cmd.exe");
        assert_eq!(
            args_to_commandline("cmd.exe", &["/d".to_string(), "/s".to_string()]),
            "cmd.exe /d /s"
        );
    }

    #[test]
    fn test_args_to_commandline_empty_arg_quoted() {
        assert_eq!(args_to_commandline("prog", &["".to_string()]), "prog \"\"");
    }

    #[test]
    fn test_args_to_commandline_spaces_quoted() {
        assert_eq!(
            args_to_commandline("C:\\Program Files\\cmd.exe", &["hello world".to_string()]),
            "\"C:\\Program Files\\cmd.exe\" \"hello world\""
        );
        assert_eq!(
            args_to_commandline("prog", &["a\tb".to_string()]),
            "prog \"a\\tb\"".replace("\\t", "\t")
        );
    }

    #[test]
    fn test_args_to_commandline_embedded_quotes() {
        // he said "hi" → "he said \"hi\""
        assert_eq!(
            args_to_commandline("prog", &["he said \"hi\"".to_string()]),
            "prog \"he said \\\"hi\\\"\""
        );
    }

    #[test]
    fn test_args_to_commandline_trailing_backslashes() {
        // Trailing backslashes of a quoted arg must be doubled.
        assert_eq!(
            args_to_commandline("prog", &["foo bar\\".to_string()]),
            "prog \"foo bar\\\\\""
        );
        // Unquoted arg keeps backslashes as-is.
        assert_eq!(
            args_to_commandline("prog", &["foo\\".to_string()]),
            "prog foo\\"
        );
        // Backslashes before an embedded quote: bs*2+1.
        assert_eq!(
            args_to_commandline("prog", &["a \"b".to_string()]),
            "prog \"a \\\"b\""
        );
    }

    #[test]
    fn test_args_to_commandline_quotes_escaped_not_rewrapped() {
        // winpty/node-pty parity (windowsPtyAgent.test.ts "array argument all
        // in quotes"): a fully-quoted arg has its quotes ESCAPED, the arg is
        // not re-wrapped.
        assert_eq!(
            args_to_commandline("asdf", &["\"surounded by quotes\"".to_string()]),
            "asdf \\\"surounded by quotes\\\""
        );
        // Lopsided quotes ARE re-wrapped (plus inner quotes escaped).
        assert_eq!(
            args_to_commandline("asdf", &["\"quotes\" near start".to_string()]),
            "asdf \"\\\"quotes\\\" near start\""
        );
    }

    /// Exact expectation battery mirrored from node-pty's official
    /// `windowsPtyAgent.test.ts` argsToCommandLine suite (winpty origin) —
    /// the compatibility bar for this port. Note: args containing quotes do
    /// not round-trip through the real `CommandLineToArgvW` (upstream parity —
    /// the algorithm targets CreateProcessW/msvcrt-style child parsers).
    #[test]
    fn test_args_to_commandline_node_pty_suite() {
        let cases: Vec<(&str, Vec<&str>, &str)> = vec![
            // Plain strings
            ("asdf", vec![], "asdf"),
            ("\\asdf\\qwer\\", vec![], "\\asdf\\qwer\\"),
            ("asdf\\\\qwer", vec![], "asdf\\\\qwer"),
            ("\"asdf\"qwer\"", vec![], "\\\"asdf\\\"qwer\\\""),
            ("asdf\\\"qwer", vec![], "asdf\\\\\\\"qwer"),
            // Quoted strings
            ("asdf qwer", vec![], "\"asdf qwer\""),
            ("", vec![], "\"\""),
            ("asdf\tqwer", vec![], "\"asdf\tqwer\""),
            ("\\asdf \\qwer\\", vec![], "\"\\asdf \\qwer\\\\\""),
            ("asdf \\\\qwer", vec![], "\"asdf \\\\qwer\""),
            ("asdf \\\"qwer", vec![], "\"asdf \\\\\\\"qwer\""),
            ("asdf qwer\\\\", vec![], "\"asdf qwer\\\\\\\\\""),
            // Multiple arguments
            (
                "asdf",
                vec!["qwer zxcv", "", "\""],
                "asdf \"qwer zxcv\" \"\" \\\"",
            ),
            (
                "asdf",
                vec!["\"surounded by quotes\""],
                "asdf \\\"surounded by quotes\\\"",
            ),
            (
                "asdf",
                vec!["quotes \"in the\" middle"],
                "asdf \"quotes \\\"in the\\\" middle\"",
            ),
            (
                "asdf",
                vec!["\"quotes\" near start"],
                "asdf \"\\\"quotes\\\" near start\"",
            ),
            (
                "asdf",
                vec!["quotes \"near end\""],
                "asdf \"quotes \\\"near end\\\"\"",
            ),
            // Real-world cases
            (
                "cmd.exe",
                vec![
                    "/c",
                    "powershell -noexit -command 'Set-location \"C:\\user\"'",
                ],
                "cmd.exe /c \"powershell -noexit -command 'Set-location \\\"C:\\user\\\"'\"",
            ),
        ];
        for (file, args, expected) in cases {
            let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                args_to_commandline(file, &owned),
                expected,
                "mismatch for file={file:?} args={args:?}"
            );
        }
    }

    #[test]
    fn test_process_start_time_self_is_stable() {
        let me = unsafe { GetCurrentProcessId() };
        let t1 = process_start_time_by_pid(me).expect("own start time");
        let t2 = process_start_time_by_pid(me).expect("own start time");
        assert_eq!(t1, t2, "creation time must be stable");
        assert!(t1 > 0);
    }

    #[test]
    fn test_process_start_time_dead_pid_none() {
        // pid 0 (System Idle Process) cannot be opened with QUERY_LIMITED.
        assert_eq!(process_start_time_by_pid(0), None);
    }

    #[test]
    fn test_now_filetime_monotonic() {
        let a = now_filetime();
        let b = now_filetime();
        assert!(b >= a);
    }

    #[test]
    fn test_kill_tree_attach_guard_rejects_wrong_start_time() {
        // Spawn a real child with its OWN hidden console (CREATE_NO_WINDOW →
        // private console, so the dance cannot see/kill our test console).
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 10 127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn guard-test child");
        let pid = child.id();
        let real_start = process_start_time_by_pid(pid).expect("child start time");

        // Tampered start time → attach guard must reject: nothing killed,
        // child survives.
        let killed = kill_console_process_tree(pid, Some(real_start ^ 0xFFFF));
        assert_eq!(killed, 0, "guard must reject a mismatched start time");
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "child must still be alive after rejected attach"
        );

        // Correct start time → attach succeeds (child has no other console
        // members, so 0 grandchildren is expected; must not panic).
        let _ = kill_console_process_tree(pid, Some(real_start));

        let _ = child.kill();
        let _ = child.wait();
    }

    /// Real kill-tree test: a shell process tree inside a PTY (shell →
    /// unique-named cmd copy → ping) must be fully reaped by kill_session.
    #[test]
    fn test_kill_session_reaps_process_tree() {
        // Unique executable name so `tasklist` probes cannot collide with
        // unrelated processes on the machine.
        let unique = format!(
            "ghita_pty_tree_{}_{}.exe",
            std::process::id(),
            now_filetime() % 1_000_000
        );
        let tmp_path = std::env::temp_dir().join(&unique);
        std::fs::copy("C:\\Windows\\System32\\cmd.exe", &tmp_path)
            .expect("copy cmd.exe to unique temp name");

        struct NullSink;
        impl crate::PtyEventSink for NullSink {
            fn on_data(&self, _session_id: &str, _data: &str) {}
            fn on_exit(&self, _session_id: &str, _status: crate::PtyExitStatus) {}
        }

        let mgr = crate::PtyManager::new();
        mgr.spawn(
            "tree_test",
            crate::SpawnOptions {
                shell: "cmd.exe".to_string(),
                args: vec![],
                cwd: None,
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            std::sync::Arc::new(NullSink),
        )
        .expect("spawn pty");

        // Give cmd.exe time to boot, then start the grandchild SYNCHRONOUSLY
        // (no `start` — `start ""` would open a new console and escape the
        // console relation we rely on). /c ping keeps the copy alive ~60s.
        std::thread::sleep(std::time::Duration::from_millis(700));
        let launch = format!("\"{}\" /c ping -n 60 127.0.0.1\r\n", tmp_path.display());
        mgr.write("tree_test", &launch).expect("write launch");

        // Wait until the grandchild actually shows up.
        let mut seen = false;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(300));
            if process_alive_by_image(&unique) {
                seen = true;
                break;
            }
        }
        assert!(
            seen,
            "unique grandchild process must be running before kill"
        );

        // Kill the session — the tree kill must reap the grandchild too.
        mgr.kill_session("tree_test");

        // Grandchild must disappear (terminated via GetConsoleProcessList).
        let mut gone = false;
        for _ in 0..40 {
            if !process_alive_by_image(&unique) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let _ = std::fs::remove_file(&tmp_path);
        assert!(
            gone,
            "grandchild must be killed by the console-aware tree kill"
        );
    }

    /// Probe whether a process with the given image name runs, via tasklist.
    fn process_alive_by_image(image_name: &str) -> bool {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image_name}")])
            .args(["/FO", "CSV"])
            .output()
            .expect("tasklist");
        let text = String::from_utf8_lossy(&output.stdout);
        text.contains(image_name)
    }
}
