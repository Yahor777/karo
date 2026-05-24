use std::fs;
use std::path::{Path, PathBuf};
use crate::errors::{ShellError, ShellResult};
use crate::paths::normalize_and_validate_path;

pub fn get_staging_root(project_path: &str, task_id: &str) -> ShellResult<PathBuf> {
    let project_root = PathBuf::from(project_path);
    if !project_root.is_absolute() {
        return Err(ShellError::InvalidPath {
            message: "Project root must be absolute".to_string(),
        });
    }
    let canonical_root = project_root.canonicalize().unwrap_or(project_root);
    
    let staging_root = canonical_root
        .join(".karo")
        .join("staging")
        .join(format!("task_{}", task_id));
        
    Ok(staging_root)
}

pub fn write_staged_file_impl(
    project_path: &str,
    task_id: &str,
    relative_path: &str,
    content: &str,
) -> ShellResult<PathBuf> {
    // 1. Validate relative path first to ensure no traversal out of the workspace.
    // This also blocks writing to .env and karo.key inside the workspace
    let _validated_target = normalize_and_validate_path(project_path, relative_path)?;

    // 2. Resolve target inside staging directory
    let staging_root = get_staging_root(project_path, task_id)?;
    
    let rel = relative_path.replace('\\', "/");
    let rel_trimmed = rel.trim_start_matches('/');
    
    let staged_file_path = staging_root.join(rel_trimmed);
    
    // Ensure staged path stays inside staging_root (security check)
    if !staged_file_path.starts_with(&staging_root) {
        return Err(ShellError::PermissionDenied {
            message: "Staged file path goes outside staging root".to_string(),
        });
    }

    // 3. Create parent directories and write
    if let Some(parent) = staged_file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&staged_file_path, content)?;

    Ok(staged_file_path)
}

pub fn get_staged_changes_impl(project_path: &str, task_id: &str) -> ShellResult<Vec<String>> {
    let staging_root = get_staging_root(project_path, task_id)?;
    if !staging_root.exists() {
        return Ok(Vec::new());
    }
    
    let mut files = Vec::new();
    collect_files(&staging_root, &staging_root, &mut files)?;
    Ok(files)
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<String>) -> ShellResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else {
            let rel = path.strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            files.push(rel);
        }
    }
    Ok(())
}
