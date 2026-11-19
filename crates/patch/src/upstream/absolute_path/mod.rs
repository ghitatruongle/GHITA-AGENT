use dirs::home_dir;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as SerdeError;
use std::borrow::Cow;
use std::cell::RefCell;
use std::path::Display;
use std::path::Path;
use std::path::PathBuf;

mod absolutize;
mod system_aliases;

/// A path that is guaranteed to be absolute and normalized (though it is not
/// guaranteed to be canonicalized or exist on the filesystem).
///
/// IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set
/// using [AbsolutePathBufGuard::new]. If no base path is set, the
/// deserialization will fail unless the path being deserialized is already
/// absolute.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, JsonSchema)]
pub struct AbsolutePathBuf(PathBuf);

impl AbsolutePathBuf {
    fn maybe_expand_home_directory(path: &Path) -> PathBuf {
        if let Some(path_str) = path.to_str()
            && let Some(rest) = path_str.strip_prefix('~')
            && let Some(home) = AbsolutePathBufGuard::home_directory()
        {
            if rest.is_empty() {
                return home;
            } else if let Some(rest) = rest.strip_prefix('/') {
                return home.join(rest.trim_start_matches('/'));
            } else if cfg!(windows)
                && let Some(rest) = rest.strip_prefix('\\')
            {
                return home.join(rest.trim_start_matches('\\'));
            }
        }
        path.to_path_buf()
    }

    pub fn resolve_path_against_base<P: AsRef<Path>, B: AsRef<Path>>(
        path: P,
        base_path: B,
    ) -> Self {
        let expanded = Self::maybe_expand_home_directory(path.as_ref());
        let expanded = normalize_path_for_platform(&expanded);
        let base_path = normalize_path_for_platform(base_path.as_ref());
        Self(absolutize::absolutize_from(
            expanded.as_ref(),
            base_path.as_ref(),
        ))
    }

    pub fn from_absolute_path<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let expanded = Self::maybe_expand_home_directory(path.as_ref());
        let expanded = normalize_path_for_platform(&expanded);
        Ok(Self(absolutize::absolutize(expanded.as_ref())?))
    }

    pub fn from_absolute_path_checked<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let expanded = Self::maybe_expand_home_directory(path.as_ref());
        let expanded = normalize_path_for_platform(&expanded);
        if !expanded.is_absolute() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("path is not absolute: {}", path.as_ref().display()),
            ));
        }

        Ok(Self(absolutize::absolutize_from(
            expanded.as_ref(),
            Path::new("/"),
        )))
    }

    pub fn current_dir() -> std::io::Result<Self> {
        Self::from_absolute_path(std::env::current_dir()?)
    }

    /// Construct an absolute path from `path`, resolving relative paths against
    /// the process current working directory.
    pub fn relative_to_current_dir<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        if path.as_ref().is_absolute() {
            return Self::from_absolute_path(path);
        }

        Ok(Self::resolve_path_against_base(
            path,
            std::env::current_dir()?,
        ))
    }

    pub fn join<P: AsRef<Path>>(&self, path: P) -> Self {
        Self::resolve_path_against_base(path, &self.0)
    }

    pub fn canonicalize(&self) -> std::io::Result<Self> {
        dunce::canonicalize(&self.0).map(Self)
    }

    pub fn parent(&self) -> Option<Self> {
        self.0.parent().map(|p| {
            debug_assert!(
                p.is_absolute(),
                "parent of AbsolutePathBuf must be absolute"
            );
            Self(p.to_path_buf())
        })
    }

    pub fn ancestors(&self) -> impl Iterator<Item = Self> + '_ {
        self.0.ancestors().map(|p| {
            debug_assert!(
                p.is_absolute(),
                "ancestor of AbsolutePathBuf must be absolute"
            );
            Self(p.to_path_buf())
        })
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn into_path_buf(self) -> PathBuf {
        self.0
    }

    pub fn to_path_buf(&self) -> PathBuf {
        self.0.clone()
    }

    pub fn to_string_lossy(&self) -> std::borrow::Cow<'_, str> {
        self.0.to_string_lossy()
    }

    pub fn display(&self) -> Display<'_> {
        self.0.display()
    }
}

fn normalize_path_for_platform(path: &Path) -> Cow<'_, Path> {
    if cfg!(windows)
        && let Some(path) = path.to_str()
        && let Some(normalized) = normalize_windows_device_path(path)
    {
        return Cow::Owned(PathBuf::from(normalized));
    }

    Cow::Borrowed(path)
}

/// Normalizes Windows drive and UNC namespace aliases on any host.
pub fn normalize_windows_device_path(path: &str) -> Option<String> {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    if let Some(unc) = path.strip_prefix(r"\\.\UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    if let Some(path) = path.strip_prefix(r"\\?\")
        && is_windows_drive_absolute_path(path)
    {
        return Some(path.to_string());
    }
    if let Some(path) = path.strip_prefix(r"\\.\")
        && is_windows_drive_absolute_path(path)
    {
        return Some(path.to_string());
    }
    None
}

fn is_windows_drive_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// Canonicalize a path when possible, but preserve the logical absolute path
/// whenever canonicalization would rewrite it through a nested symlink.
///
/// Top-level system aliases such as macOS `/var -> /private/var` still remain
/// canonicalized so existing runtime expectations around those paths stay
/// stable. If the full path cannot be canonicalized, this returns the logical
/// absolute path; use [`canonicalize_existing_preserving_symlinks`] for paths
/// that must exist.
pub fn canonicalize_preserving_symlinks(path: &Path) -> std::io::Result<PathBuf> {
    let logical = AbsolutePathBuf::from_absolute_path(path)?.into_path_buf();
    let preserve_logical_path = should_preserve_logical_path(&logical);
    match dunce::canonicalize(path) {
        Ok(canonical) if preserve_logical_path && canonical != logical => Ok(logical),
        Ok(canonical) => Ok(canonical),
        Err(_) => Ok(logical),
    }
}

/// Canonicalize an existing path while preserving the logical absolute path
/// whenever canonicalization would rewrite it through a nested symlink.
///
/// Unlike [`canonicalize_preserving_symlinks`], canonicalization failures are
/// propagated so callers can reject invalid working directories early.
pub fn canonicalize_existing_preserving_symlinks(path: &Path) -> std::io::Result<PathBuf> {
    let logical = AbsolutePathBuf::from_absolute_path(path)?.into_path_buf();
    let canonical = dunce::canonicalize(path)?;
    if should_preserve_logical_path(&logical) && canonical != logical {
        Ok(logical)
    } else {
        Ok(canonical)
    }
}

fn should_preserve_logical_path(logical: &Path) -> bool {
    logical.ancestors().any(|ancestor| {
        let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
            return false;
        };
        metadata.file_type().is_symlink() && ancestor.parent().and_then(Path::parent).is_some()
    })
}

impl AsRef<Path> for AbsolutePathBuf {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl std::ops::Deref for AbsolutePathBuf {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<AbsolutePathBuf> for PathBuf {
    fn from(path: AbsolutePathBuf) -> Self {
        path.into_path_buf()
    }
}

/// Helpers for constructing absolute paths in tests.
pub mod test_support {
    use super::AbsolutePathBuf;
    use std::path::Path;
    use std::path::PathBuf;

    /// Creates a platform-absolute [`PathBuf`] from a Unix-style absolute test path.
    ///
    /// On Windows, `/tmp/example` maps to `C:\tmp\example`.
    pub fn test_path_buf(unix_path: &str) -> PathBuf {
        if cfg!(windows) {
            let mut path = PathBuf::from(r"C:\");
            path.extend(
                unix_path
                    .trim_start_matches('/')
                    .split('/')
                    .filter(|segment| !segment.is_empty()),
            );
            path
        } else {
            PathBuf::from(unix_path)
        }
    }

    /// Extension methods for converting paths into [`AbsolutePathBuf`] values in tests.
    pub trait PathExt {
        /// Converts an already absolute path into an [`AbsolutePathBuf`].
        fn abs(&self) -> AbsolutePathBuf;
    }

    impl PathExt for Path {
        #[expect(clippy::expect_used)]
        fn abs(&self) -> AbsolutePathBuf {
            AbsolutePathBuf::from_absolute_path_checked(self)
                .expect("path should already be absolute")
        }
    }

    /// Extension methods for converting path buffers into [`AbsolutePathBuf`] values in tests.
    pub trait PathBufExt {
        /// Converts an already absolute path buffer into an [`AbsolutePathBuf`].
        fn abs(&self) -> AbsolutePathBuf;
    }

    impl PathBufExt for PathBuf {
        fn abs(&self) -> AbsolutePathBuf {
            self.as_path().abs()
        }
    }
}

impl TryFrom<&Path> for AbsolutePathBuf {
    type Error = std::io::Error;

    fn try_from(value: &Path) -> Result<Self, Self::Error> {
        Self::from_absolute_path(value)
    }
}

impl TryFrom<PathBuf> for AbsolutePathBuf {
    type Error = std::io::Error;

    fn try_from(value: PathBuf) -> Result<Self, Self::Error> {
        Self::from_absolute_path(value)
    }
}

impl TryFrom<&str> for AbsolutePathBuf {
    type Error = std::io::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_absolute_path(value)
    }
}

impl TryFrom<String> for AbsolutePathBuf {
    type Error = std::io::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_absolute_path(value)
    }
}

thread_local! {
    static ABSOLUTE_PATH_BASE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static ABSOLUTE_PATH_HOME: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Ensure this guard is held while deserializing `AbsolutePathBuf` values to
/// provide a base path for resolving relative paths. Because this relies on
/// thread-local storage, the deserialization must be single-threaded and
/// occur on the same thread that created the guard.
pub struct AbsolutePathBufGuard;

impl AbsolutePathBufGuard {
    /// Reads the native deserialization base and validates the guard requirement
    /// before home expansion or namespace normalization. Does not look up cwd.
    pub fn deserialization_base(path: &Path) -> Result<Option<PathBuf>, &'static str> {
        let base = ABSOLUTE_PATH_BASE.with(|cell| cell.borrow().clone());
        if base.is_none() && !path.is_absolute() {
            return Err("AbsolutePathBuf deserialized without a base path");
        }
        Ok(base)
    }

    /// Reads the effective native home, including the thread-local override.
    pub fn home_directory() -> Option<PathBuf> {
        ABSOLUTE_PATH_HOME
            .with(|cell| cell.borrow().clone())
            .or_else(home_dir)
    }

    pub fn new(base_path: &Path) -> Self {
        ABSOLUTE_PATH_BASE.with(|cell| {
            *cell.borrow_mut() = Some(base_path.to_path_buf());
        });
        Self
    }

    /// Resolves home-relative paths against `home_directory` during `operation`.
    /// The operation must complete synchronously on the current thread.
    pub fn with_home_directory<T>(home_directory: &Path, operation: impl FnOnce() -> T) -> T {
        let previous_home =
            ABSOLUTE_PATH_HOME.with(|cell| cell.replace(Some(home_directory.to_path_buf())));
        let _guard = HomeDirectoryGuard(previous_home);
        operation()
    }
}

impl Drop for AbsolutePathBufGuard {
    fn drop(&mut self) {
        ABSOLUTE_PATH_BASE.with(|cell| {
            *cell.borrow_mut() = None;
        });
    }
}

struct HomeDirectoryGuard(Option<PathBuf>);

impl Drop for HomeDirectoryGuard {
    fn drop(&mut self) {
        ABSOLUTE_PATH_HOME.with(|cell| {
            *cell.borrow_mut() = self.0.take();
        });
    }
}

impl<'de> Deserialize<'de> for AbsolutePathBuf {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let path = PathBuf::deserialize(deserializer)?;
        match AbsolutePathBufGuard::deserialization_base(&path)
            .map_err(SerdeError::custom)?
            .as_deref()
        {
            Some(base) => Ok(Self::resolve_path_against_base(path, base)),
            None => Self::from_absolute_path(path).map_err(SerdeError::custom),
        }
    }
}
