use std::path::PathBuf;
use crate::errors::{ShellError, ShellResult};

pub fn normalize_and_validate_path(project_path: &str, relative_path: &str) -> ShellResult<PathBuf> {
    let project_root = PathBuf::from(project_path);
    if !project_root.is_absolute() {
        return Err(ShellError::InvalidPath {
            message: "Project root must be absolute".to_string(),
        });
    }

    // Canonicalize the project root to ensure symlinks/junctions are resolved.
    let canonical_root = project_root.canonicalize().unwrap_or(project_root.clone());

    // Normalize relative path: replace backslashes with forward slashes
    let rel = relative_path.replace('\\', "/");
    let rel_trimmed = rel.trim_start_matches('/');

    // Block path traversal attempts (..)
    if rel_trimmed.contains("..") || rel_trimmed.split('/').any(|part| part == "..") {
        return Err(ShellError::PermissionDenied {
            message: "Path traversal is strictly prohibited".to_string(),
        });
    }

    // Join and resolve target path
    let target_path = canonical_root.join(rel_trimmed);

    // Ensure the target path is strictly inside canonical_root
    if !target_path.starts_with(&canonical_root) {
        return Err(ShellError::OutsideWorkspace {
            target: target_path.to_string_lossy().into_owned(),
            workspace: canonical_root.to_string_lossy().into_owned(),
        });
    }

    // Block access to .git and VCS files
    for component in target_path.components() {
        if let Some(name) = component.as_os_str().to_str() {
            if name == ".git" {
                return Err(ShellError::PermissionDenied {
                    message: "Access to .git repository internals is strictly blocked".to_string(),
                });
            }
        }
    }

    // Block access to .env and secret files
    if let Some(file_name) = target_path.file_name().and_then(|n| n.to_str()) {
        let lower = file_name.to_lowercase();
        if lower == ".env" || lower.starts_with(".env.") || lower == "karo.key" {
            return Err(ShellError::PermissionDenied {
                message: format!("Writing to sensitive config file '{}' is blocked", file_name),
            });
        }
    }

    Ok(target_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_path() {
        let temp_dir = std::env::temp_dir();
        let canonical_temp = temp_dir.canonicalize().unwrap();
        let root = canonical_temp.to_string_lossy().into_owned();

        let res = normalize_and_validate_path(&root, "src/hello.txt");
        assert!(res.is_ok());
        let path = res.unwrap();
        assert!(path.starts_with(&canonical_temp));
        assert!(path.to_string_lossy().contains("src"));
    }

    #[test]
    fn test_path_traversal() {
        let temp_dir = std::env::temp_dir();
        let canonical_temp = temp_dir.canonicalize().unwrap();
        let root = canonical_temp.to_string_lossy().into_owned();

        let res = normalize_and_validate_path(&root, "../outside.ts");
        assert!(res.is_err());
        match res.err().unwrap() {
            ShellError::PermissionDenied { .. } => {}
            other => panic!("Expected PermissionDenied error, got {:?}", other),
        }
    }

    #[test]
    fn test_outside_root() {
        let root = "C:\\my-project".to_string();
        let res = normalize_and_validate_path(&root, "D:\\other-place\\file.ts");
        assert!(res.is_err());
    }

    #[test]
    fn test_blocked_files() {
        let temp_dir = std::env::temp_dir();
        let canonical_temp = temp_dir.canonicalize().unwrap();
        let root = canonical_temp.to_string_lossy().into_owned();

        let res1 = normalize_and_validate_path(&root, ".env");
        assert!(res1.is_err());

        let res2 = normalize_and_validate_path(&root, "src/.env.local");
        assert!(res2.is_err());

        let res3 = normalize_and_validate_path(&root, "karo.key");
        assert!(res3.is_err());

        let res4 = normalize_and_validate_path(&root, ".git/config");
        assert!(res4.is_err());

        let res5 = normalize_and_validate_path(&root, "subfolder/.git/HEAD");
        assert!(res5.is_err());
    }
}
