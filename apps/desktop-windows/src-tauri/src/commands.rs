use tauri::State;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use crate::AppState;
use crate::errors::{ShellError, ShellResult};
use crate::storage::{encrypt_secret_obfuscated, decrypt_secret_obfuscated};
use crate::tasks::{
    TaskInternalPersistent, TraceEvent, ArtifactVersion,
    ArtifactMetadata, ApplyResult
};
use crate::staging::{write_staged_file_impl, get_staged_changes_impl};
use crate::apply::apply_staged_changes_impl;
use crate::paths::normalize_and_validate_path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPreviewFileResult {
    pub path: String,
    pub opened: bool,
}

#[tauri::command]
pub fn shell_get_device_id(state: State<'_, AppState>) -> ShellResult<String> {
    let dev_id = match state.storage.read_setting("device_id")? {
        Some(Value::String(s)) => s,
        _ => {
            let new_id = format!(
                "device_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );
            state.storage.write_setting("device_id".to_string(), Value::String(new_id.clone()))?;
            new_id
        }
    };
    Ok(dev_id)
}

#[tauri::command]
pub fn shell_read_local_setting(state: State<'_, AppState>, key: String) -> ShellResult<Option<Value>> {
    state.storage.read_setting(&key)
}

#[tauri::command]
pub fn shell_write_local_setting(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> ShellResult<()> {
    state.storage.write_setting(key, value)
}

#[tauri::command]
pub fn shell_delete_local_setting(state: State<'_, AppState>, key: String) -> ShellResult<()> {
    state.storage.delete_setting(&key)
}

#[tauri::command]
pub fn shell_encrypt_local_secret(secret: String) -> ShellResult<crate::EncryptedBlob> {
    encrypt_secret_obfuscated(&secret)
}

#[tauri::command]
pub fn shell_decrypt_local_secret(blob: crate::EncryptedBlob) -> ShellResult<String> {
    decrypt_secret_obfuscated(blob)
}

#[tauri::command]
pub fn shell_write_local_log(entry: crate::LocalLogEntry) -> ShellResult<()> {
    println!("[LOCAL LOG]: [{}]: {}", entry.level, entry.message);
    Ok(())
}

#[tauri::command]
pub fn shell_export_file(
    suggested_file_name: String,
    bytes: Vec<u8>,
) -> ShellResult<crate::ExportFileResult> {
    let _ = (suggested_file_name, bytes);
    Err(ShellError::NotImplemented {
        command: "shell_export_file",
    })
}

#[tauri::command]
pub fn shell_show_notification(title: String, body: String) -> ShellResult<()> {
    println!("[NOTIFICATION] Title: {}, Body: {}", title, body);
    Ok(())
}

#[tauri::command]
pub fn shell_read_file(project_path: String, relative_path: String) -> ShellResult<String> {
    let target = normalize_and_validate_path(&project_path, &relative_path)?;
    let content = fs::read_to_string(&target)?;
    Ok(content)
}

#[tauri::command]
pub fn shell_open_preview_file(
    project_path: String,
    relative_path: String,
) -> ShellResult<OpenPreviewFileResult> {
    let target = resolve_preview_file_path(&project_path, &relative_path)?;
    open_file_with_system_handler(&target)?;
    Ok(OpenPreviewFileResult {
        path: target.to_string_lossy().to_string(),
        opened: true,
    })
}

pub fn resolve_preview_file_path(project_path: &str, relative_path: &str) -> ShellResult<PathBuf> {
    if PathBuf::from(relative_path).is_absolute() {
        return Err(ShellError::PermissionDenied {
            message: "Preview file path must be relative to the selected project root.".to_string(),
        });
    }
    let target = normalize_and_validate_path(project_path, relative_path)?;
    if !target.exists() || !target.is_file() {
        return Err(ShellError::InvalidPath {
            message: format!(
                "Preview file does not exist yet: {}. Apply Changes before preview.",
                relative_path
            ),
        });
    }
    let extension = target
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "html" && extension != "htm" {
        return Err(ShellError::PermissionDenied {
            message: "Static preview can only open .html/.htm files inside the project.".to_string(),
        });
    }
    Ok(target.canonicalize().unwrap_or(target))
}

fn open_file_with_system_handler(target: &Path) -> ShellResult<()> {
    let mut command = if cfg!(windows) {
        let mut cmd = Command::new("rundll32.exe");
        cmd.arg("url.dll,FileProtocolHandler");
        cmd.arg(target.to_string_lossy().to_string());
        cmd
    } else if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(target);
        cmd
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(target);
        cmd
    };
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

#[tauri::command]
pub fn shell_write_staged_file(
    project_path: String,
    task_id: String,
    relative_path: String,
    content: String,
) -> ShellResult<()> {
    let _staged_path = write_staged_file_impl(&project_path, &task_id, &relative_path, &content)?;
    Ok(())
}

#[tauri::command]
pub fn shell_get_staged_changes(project_path: String, task_id: String) -> ShellResult<Vec<String>> {
    get_staged_changes_impl(&project_path, &task_id)
}

#[tauri::command]
pub fn shell_apply_staged_changes(
    state: State<'_, AppState>,
    project_path: String,
    task_id: String,
    approval: bool,
) -> ShellResult<ApplyResult> {
    if !approval {
        return Err(ShellError::PermissionDenied {
            message: "Changes cannot be applied without explicit user approval.".to_string(),
        });
    }
    let apply_res = apply_staged_changes_impl(&project_path, &task_id)?;
    if let Some(mut task) = state.storage.get_task(&task_id)? {
        task.apply_result = Some(apply_res.clone());
        task.state.status = if apply_res.success {
            "completed".to_string()
        } else {
            "error".to_string()
        };
        state.storage.save_task(task)?;
    }
    Ok(apply_res)
}

#[tauri::command]
pub fn shell_create_task_run(
    state: State<'_, AppState>,
    task: TaskInternalPersistent,
) -> ShellResult<()> {
    state.storage.save_task(task)
}

#[tauri::command]
pub fn shell_update_task_run(
    state: State<'_, AppState>,
    task: TaskInternalPersistent,
) -> ShellResult<()> {
    state.storage.save_task(task)
}

#[tauri::command]
pub fn shell_get_task_run(
    state: State<'_, AppState>,
    task_id: String,
) -> ShellResult<Option<TaskInternalPersistent>> {
    state.storage.get_task(&task_id)
}

#[tauri::command]
pub fn shell_list_task_runs(
    state: State<'_, AppState>,
    project_path: String,
) -> ShellResult<Vec<TaskInternalPersistent>> {
    let _ = project_path;
    state.storage.list_tasks()
}

#[tauri::command]
pub fn shell_add_agent_run(
    state: State<'_, AppState>,
    task_id: String,
    agent_run: TraceEvent,
) -> ShellResult<()> {
    if let Some(mut task) = state.storage.get_task(&task_id)? {
        task.trace.push(agent_run);
        state.storage.save_task(task)?;
    }
    Ok(())
}

#[tauri::command]
pub fn shell_add_artifact(
    state: State<'_, AppState>,
    task_id: String,
    artifact_version: ArtifactVersion,
    artifact_meta: ArtifactMetadata,
) -> ShellResult<()> {
    if let Some(mut task) = state.storage.get_task(&task_id)? {
        task.artifact_meta.retain(|m| m.id != artifact_meta.id);
        task.artifact_meta.push(artifact_meta);
        task.artifacts.push(artifact_version);
        state.storage.save_task(task)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resolve_preview_file_path;
    use std::fs;

    #[test]
    fn resolves_existing_html_preview_inside_project() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("src/site")).unwrap();
        fs::write(temp.path().join("src/site/index.html"), "<h1>Karo</h1>").unwrap();

        let resolved = resolve_preview_file_path(
            temp.path().to_string_lossy().as_ref(),
            "src/site/index.html",
        )
        .expect("html preview should resolve");

        assert!(resolved.ends_with("src/site/index.html") || resolved.ends_with("src\\site\\index.html"));
    }

    #[test]
    fn blocks_preview_outside_project_or_non_html() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("notes.txt"), "not html").unwrap();

        let txt = resolve_preview_file_path(temp.path().to_string_lossy().as_ref(), "notes.txt");
        assert!(txt.is_err());

        let traversal = resolve_preview_file_path(temp.path().to_string_lossy().as_ref(), "../index.html");
        assert!(traversal.is_err());
    }
}
