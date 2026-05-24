use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellError {
    #[error("desktop shell command \"{command}\" is not implemented yet")]
    NotImplemented { command: &'static str },
    #[error("invalid path: {message}")]
    InvalidPath { message: String },
    #[error("outside workspace: target {target} is outside workspace {workspace}")]
    OutsideWorkspace { target: String, workspace: String },
    #[error("permission denied: {message}")]
    PermissionDenied { message: String },
    #[error("apply conflict: {message}")]
    ApplyConflict { message: String },
    #[error("io error: {message}")]
    IoError { message: String },
    #[error("storage error: {message}")]
    StorageError { message: String },
    #[error("provider probe failed: {message}")]
    ProbeFailed { code: String, message: String },
}

impl From<std::io::Error> for ShellError {
    fn from(err: std::io::Error) -> Self {
        ShellError::IoError { message: err.to_string() }
    }
}

pub type ShellResult<T> = Result<T, ShellError>;
