//! GHITA patch application — thin wrapper around vendored codex apply-patch core.
//! Phần còn lại của Ghita chỉ thấy `apply()` + types bên dưới.

#[cfg(feature = "addon")]
mod napi;

pub mod upstream;

use std::path::Path;

use crate::upstream::apply_patch::AppliedPatchDelta;
use crate::upstream::file_system::StdFs;
use crate::upstream::path_uri::PathUri;

#[derive(Debug, Clone, PartialEq)]
pub struct AppliedChanges {
    pub applied: Vec<String>,
    pub skipped: Vec<String>,
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PatchError {
    Malformed(String),
    Io(String),
}

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PatchError::Malformed(m) | PatchError::Io(m) => f.write_str(m),
        }
    }
}

/// V4A headers khai báo intent: Add/Update/Delete. Rename ("*** Move to:")
/// được xử lý ở collect() qua move_path của delta change.
fn intended_paths(patch_text: &str) -> Vec<String> {
    const MARKERS: [&str; 3] = ["*** Add File: ", "*** Update File: ", "*** Delete File: "];
    patch_text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            MARKERS
                .iter()
                .find_map(|m| line.strip_prefix(m).map(str::to_string))
        })
        .collect()
}

/// Chuẩn hóa path để so khớp: forward slashes + lowercase (Windows
/// case-insensitive — bug F1 của review v0.0.2-preview).
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// Relative path so với cwd (forward slashes); fallback = nguyên bản.
fn rel_path(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn collect(delta: AppliedPatchDelta, intended: &[String], cwd: &Path) -> AppliedChanges {
    use crate::upstream::apply_patch::AppliedPatchFileChange;
    let mut applied: Vec<String> = Vec::new();
    let mut satisfied: std::collections::HashSet<String> = std::collections::HashSet::new();
    for ch in delta.changes() {
        let old_rel = rel_path(&ch.path.to_path_buf(), cwd);
        if let AppliedPatchFileChange::Update {
            move_path: Some(newp),
            ..
        } = &ch.change
        {
            // Rename: file tồn tại ở new path; old path tính là đã xử lý.
            applied.push(rel_path(&newp.to_path_buf(), cwd));
            satisfied.insert(norm_path(&old_rel));
        } else {
            applied.push(old_rel);
        }
    }
    let applied_norm: std::collections::HashSet<String> =
        applied.iter().map(|p| norm_path(p)).collect();
    let skipped: Vec<String> = intended
        .iter()
        .filter(|p| {
            let n = norm_path(p);
            !applied_norm.contains(&n) && !satisfied.contains(&n)
        })
        .cloned()
        .collect();
    let partial = !applied.is_empty() && !skipped.is_empty();
    AppliedChanges {
        applied,
        skipped,
        partial,
    }
}

pub fn apply(patch_text: &str, cwd: &Path) -> Result<AppliedChanges, PatchError> {
    let cwd_uri = PathUri::from_host_native_path(cwd)
        .map_err(|e| PatchError::Malformed(format!("cwd: {e}")))?;
    let fs = StdFs;
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(|e| PatchError::Io(format!("tokio runtime: {e}")))?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let intended = intended_paths(patch_text);
    let outcome = rt.block_on(upstream::apply_patch::apply_patch(
        patch_text,
        &cwd_uri,
        &mut stdout,
        &mut stderr,
        &fs,
        None,
    ));
    match outcome {
        Ok(delta) => Ok(collect(delta, &intended, cwd)),
        Err(failure) => {
            let (err, delta) = failure.into_parts();
            let r = collect(delta, &intended, cwd);
            if r.applied.is_empty() && r.skipped.is_empty() {
                Err(PatchError::Malformed(err.to_string()))
            } else {
                Ok(r)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tempdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ghita-patch-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &PathBuf) {
        let _ = fs::remove_dir_all(dir);
    }

    const SIMPLE_PATCH: &str = "*** Begin Patch\n*** Update File: a.txt\n@@\n hello\n-old line\n+new line\n world\n*** End Patch\n";

    #[test]
    fn applies_simple_update() {
        let dir = tempdir("simple");
        fs::write(dir.join("a.txt"), "hello\nold line\nworld\n").unwrap();
        let r = apply(SIMPLE_PATCH, &dir).unwrap();
        assert_eq!(r.applied, vec!["a.txt".to_string()]);
        assert!(r.skipped.is_empty());
        assert!(!r.partial);
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "hello\nnew line\nworld\n"
        );
        cleanup(&dir);
    }

    #[test]
    fn skips_file_when_context_mismatch() {
        let dir = tempdir("mismatch");
        fs::write(dir.join("a.txt"), "totally different content\n").unwrap();
        let r = apply(SIMPLE_PATCH, &dir).unwrap();
        assert!(r.applied.is_empty());
        assert_eq!(r.skipped, vec!["a.txt".to_string()]);
        cleanup(&dir);
    }

    #[test]
    fn rename_via_move_to_counts_as_applied() {
        let dir = tempdir("rename");
        fs::write(
            dir.join("old.txt"),
            "hello
old line
world
",
        )
        .unwrap();
        let patch = "*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
 hello
-old line
+new line
 world
*** End Patch
";
        let r = apply(patch, &dir).unwrap();
        assert_eq!(r.applied, vec!["new.txt".to_string()]);
        assert!(
            r.skipped.is_empty(),
            "rename không được đếm skipped oan: {:?}",
            r.skipped
        );
        assert!(!r.partial);
        assert!(dir.join("new.txt").exists());
        cleanup(&dir);
    }

    #[test]
    fn partial_when_two_files_one_mismatches() {
        let dir = tempdir("partial");
        fs::write(dir.join("good.txt"), "hello\nold line\nworld\n").unwrap();
        fs::write(dir.join("bad.txt"), "unrelated\n").unwrap();
        let patch = "*** Begin Patch\n*** Update File: good.txt\n@@\n hello\n-old line\n+new line\n world\n*** Update File: bad.txt\n@@\n unrelated\n-x\n+y\n*** End Patch\n";
        let r = apply(patch, &dir).unwrap();
        assert_eq!(r.applied, vec!["good.txt".to_string()]);
        assert_eq!(r.skipped, vec!["bad.txt".to_string()]);
        assert!(r.partial);
        cleanup(&dir);
    }
}
