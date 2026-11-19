//! Trimmed filesystem abstraction (from openai/codex `file-system` crate @ rust-v0.169.0).
//! Chỉ giữ những member mà `apply_patch` dùng thật: read_file / write_file /
//! create_directory / get_metadata + impl std::fs (`StdFs`).

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::time::UNIX_EPOCH;

use crate::upstream::path_uri::PathUri;

pub type FileSystemResult<T> = io::Result<T>;

pub type ExecutorFileSystemFuture<'a, T> =
    Pin<Box<dyn Future<Output = FileSystemResult<T>> + Send + 'a>>;

/// Stub thay cho struct protocol-backed của upstream — vendoring bỏ protocol,
/// và wrapper của Ghita luôn truyền `None`.
pub struct FileSystemSandboxContext;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReadFileOptions {
    pub follow_symlinks: bool,
}

impl Default for ReadFileOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileOptions {
    pub follow_symlinks: bool,
}

impl Default for WriteFileOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GetMetadataOptions {
    pub follow_symlinks: bool,
}

impl Default for GetMetadataOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreateDirectoryOptions {
    pub recursive: bool,
    pub follow_symlinks: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoveOptions {
    pub recursive: bool,
    pub force: bool,
    pub follow_symlinks: bool,
}

pub struct FileMetadata {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// Abstract filesystem access (bản rút gọn — chỉ 4 method mà apply_patch gọi).
pub trait ExecutorFileSystem: Send + Sync {
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>;

    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        options: WriteFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;

    fn create_directory<'a>(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;

    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        options: GetMetadataOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>;

    fn remove<'a>(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;

    /// Đọc file + decode UTF-8 (default impl từ upstream).
    fn read_file_text<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, String> {
        Box::pin(async move {
            let bytes = self.read_file(path, options, sandbox).await?;
            String::from_utf8(bytes).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
        })
    }
}

/// std::fs implementation cho local disk.
pub struct StdFs;

impl ExecutorFileSystem for StdFs {
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        _options: ReadFileOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        Box::pin(async move { std::fs::read(path.to_path_buf()) })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        _options: WriteFileOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move { std::fs::write(path.to_path_buf(), contents) })
    }

    fn create_directory<'a>(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            if options.recursive {
                std::fs::create_dir_all(path.to_path_buf())
            } else {
                std::fs::create_dir(path.to_path_buf())
            }
        })
    }

    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        options: GetMetadataOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        Box::pin(async move {
            let p = path.to_path_buf();
            let md = if options.follow_symlinks {
                std::fs::metadata(&p)
            } else {
                std::fs::symlink_metadata(&p)
            }?;
            let created_ms = md
                .created()
                .or_else(|_| md.modified())
                .and_then(|t| {
                    t.duration_since(UNIX_EPOCH)
                        .map_err(|_| io::Error::other("time before epoch"))
                })
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let modified_ms = md
                .modified()
                .and_then(|t| {
                    t.duration_since(UNIX_EPOCH)
                        .map_err(|_| io::Error::other("time before epoch"))
                })
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Ok(FileMetadata {
                is_directory: md.is_dir(),
                is_file: md.is_file(),
                is_symlink: md.file_type().is_symlink(),
                size: md.len(),
                created_at_ms: created_ms,
                modified_at_ms: modified_ms,
            })
        })
    }

    fn remove<'a>(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            let p = path.to_path_buf();
            if options.recursive {
                if p.is_dir() {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_file(&p)
                }
            } else {
                std::fs::remove_file(&p)
            }
        })
    }
}
