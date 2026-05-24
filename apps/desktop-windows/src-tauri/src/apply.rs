use std::fs;
use crate::errors::{ShellError, ShellResult};
use crate::paths::normalize_and_validate_path;
use crate::staging::{get_staging_root, get_staged_changes_impl};
use crate::tasks::ApplyResult;

pub fn apply_staged_changes_impl(
    project_path: &str,
    task_id: &str,
) -> ShellResult<ApplyResult> {
    let staging_root = get_staging_root(project_path, task_id)?;
    if !staging_root.exists() {
        return Err(ShellError::ApplyConflict {
            message: format!("Staging workspace for task {} does not exist", task_id),
        });
    }

    let staged_files = get_staged_changes_impl(project_path, task_id)?;
    if staged_files.is_empty() {
        return Ok(ApplyResult {
            success: true,
            changed_files: Vec::new(),
            created_files: Vec::new(),
            overwritten_files: Vec::new(),
            skipped_files: Vec::new(),
            errors: Vec::new(),
        });
    }

    let mut changed_files = Vec::new();
    let mut created_files = Vec::new();
    let mut overwritten_files = Vec::new();
    let mut skipped_files = Vec::new();
    let mut errors = Vec::new();
    let mut success = true;

    for rel_path in staged_files {
        // 1. Safety validation
        let target_file_path = match normalize_and_validate_path(project_path, &rel_path) {
            Ok(p) => p,
            Err(e) => {
                success = false;
                errors.push(format!("{}: {}", rel_path, e.to_string()));
                continue;
            }
        };

        let staged_file_path = staging_root.join(&rel_path);
        
        let content = match fs::read(&staged_file_path) {
            Ok(c) => c,
            Err(e) => {
                success = false;
                errors.push(format!("{}: Failed to read staged content: {}", rel_path, e));
                continue;
            }
        };

        // 2. Check if file already exists in project root
        let file_exists = target_file_path.exists();
        if file_exists {
            // Check if contents are identical
            if let Ok(existing_content) = fs::read(&target_file_path) {
                if existing_content == content {
                    skipped_files.push(rel_path.clone());
                    continue;
                }
            }

            // Create a backup file: e.g. hello.txt -> hello.txt.bak
            let mut backup_path = target_file_path.clone();
            if let Some(ext) = backup_path.extension() {
                let mut new_ext = ext.to_os_string();
                new_ext.push(".bak");
                backup_path.set_extension(new_ext);
            } else {
                backup_path.set_extension("bak");
            }

            if let Err(e) = fs::copy(&target_file_path, &backup_path) {
                success = false;
                errors.push(format!("{}: Failed to create backup: {}", rel_path, e));
                continue;
            }
            overwritten_files.push(rel_path.clone());
        } else {
            created_files.push(rel_path.clone());
        }

        // 3. Write target file
        if let Some(parent) = target_file_path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                success = false;
                errors.push(format!("{}: Failed to create directories: {}", rel_path, e));
                continue;
            }
        }

        match fs::write(&target_file_path, &content) {
            Ok(_) => {
                changed_files.push(rel_path.clone());
            }
            Err(e) => {
                success = false;
                errors.push(format!("{}: Failed to write to project: {}", rel_path, e));
            }
        }
    }

    Ok(ApplyResult {
        success,
        changed_files,
        created_files,
        overwritten_files,
        skipped_files,
        errors,
    })
}
