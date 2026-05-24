use crate::errors::{ShellError, ShellResult};
use crate::paths::normalize_and_validate_path;

pub fn validate_file_write_permission(project_path: &str, relative_path: &str) -> ShellResult<()> {
    let _validated_path = normalize_and_validate_path(project_path, relative_path)?;
    Ok(())
}

pub fn validate_shell_execution(_command: &str) -> ShellResult<()> {
    Err(ShellError::PermissionDenied {
        message: "Automated shell execution is disabled in this sprint. Please run command manually or authorize execution.".to_string(),
    })
}
