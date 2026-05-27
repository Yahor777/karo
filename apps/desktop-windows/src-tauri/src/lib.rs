pub mod errors;
pub mod paths;
pub mod storage;
pub mod tasks;
pub mod staging;
pub mod apply;
pub mod security;
pub mod commands;
pub mod context;
pub mod terminal;
pub mod runtime;

use tauri::Manager;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use errors::{ShellError, ShellResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedBlob {
    pub algorithm: String,
    pub ciphertext: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogEntry {
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileResult {
    pub saved_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateFolderPathResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryEntry {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummarySnippet {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryResponse {
    pub root_path: String,
    pub files: Vec<ProjectSummaryEntry>,
    pub snippets: Vec<ProjectSummarySnippet>,
    pub omitted: Vec<String>,
}

const DEFAULT_PROBE_TIMEOUT_MS: u64 = 10_000;
const PROJECT_SUMMARY_MAX_ENTRIES: usize = 160;
const PROJECT_SUMMARY_MAX_SNIPPETS: usize = 12;
const PROJECT_SUMMARY_SNIPPET_BYTES: usize = 4_000;

pub struct AppState {
    pub storage: storage::Storage,
    pub terminal: terminal::TerminalManager,
}

#[tauri::command]
fn shell_validate_folder_path(path: String) -> ShellResult<ValidateFolderPathResponse> {
    Ok(validate_folder_path_impl(&path))
}

#[tauri::command]
fn shell_read_project_summary(path: String) -> ShellResult<ProjectSummaryResponse> {
    let validation = validate_folder_path_impl(&path);
    if !validation.ok {
        return Err(ShellError::ProbeFailed {
            code: validation.reason.unwrap_or_else(|| "invalid_path".to_string()),
            message: validation
                .message
                .unwrap_or_else(|| "Project folder is not readable".to_string()),
        });
    }
    let root_path = validation.normalized_path.unwrap_or(path);
    let root = PathBuf::from(&root_path);
    let mut files = Vec::new();
    let mut snippets = Vec::new();
    let mut omitted = Vec::new();
    collect_project_summary(&root, &root, 0, &mut files, &mut snippets, &mut omitted);
    Ok(ProjectSummaryResponse {
        root_path,
        files,
        snippets,
        omitted,
    })
}

fn validate_folder_path_impl(path: &str) -> ValidateFolderPathResponse {
    let trimmed = path
        .trim()
        .trim_matches(|c| c == '\'' || c == '"')
        .trim();
    if trimmed.is_empty() {
        return invalid_folder("invalid_path", "Project path cannot be empty.");
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return invalid_folder("invalid_path", "Project path must be absolute.");
    }
    match fs::metadata(&candidate) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return invalid_folder("not_directory", "Path is not a folder.");
            }
        }
        Err(err) => {
            let reason = match err.kind() {
                std::io::ErrorKind::NotFound => "not_found",
                std::io::ErrorKind::PermissionDenied => "permission_denied",
                _ => "invalid_path",
            };
            return invalid_folder(reason, &err.to_string());
        }
    }
    let normalized = fs::canonicalize(&candidate).unwrap_or(candidate);
    ValidateFolderPathResponse {
        ok: true,
        normalized_path: Some(normalized.to_string_lossy().to_string()),
        reason: None,
        message: None,
    }
}

fn invalid_folder(reason: &str, message: &str) -> ValidateFolderPathResponse {
    ValidateFolderPathResponse {
        ok: false,
        normalized_path: None,
        reason: Some(reason.to_string()),
        message: Some(message.to_string()),
    }
}

fn collect_project_summary(
    root: &Path,
    dir: &Path,
    depth: usize,
    files: &mut Vec<ProjectSummaryEntry>,
    snippets: &mut Vec<ProjectSummarySnippet>,
    omitted: &mut Vec<String>,
) {
    if depth > 3 || files.len() >= PROJECT_SUMMARY_MAX_ENTRIES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            omitted.push(format!("{}: {}", display_relative(root, dir), err));
            return;
        }
    };
    let mut sorted = entries.filter_map(Result::ok).collect::<Vec<_>>();
    sorted.sort_by_key(|e| e.file_name());
    for entry in sorted {
        if files.len() >= PROJECT_SUMMARY_MAX_ENTRIES {
            omitted.push("entry limit reached".to_string());
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_path(&name) {
            omitted.push(display_relative(root, &path));
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(err) => {
                omitted.push(format!("{}: {}", display_relative(root, &path), err));
                continue;
            }
        };
        if meta.is_dir() {
            files.push(ProjectSummaryEntry {
                path: display_relative(root, &path),
                kind: "directory".to_string(),
            });
            collect_project_summary(root, &path, depth + 1, files, snippets, omitted);
        } else if meta.is_file() {
            let rel = display_relative(root, &path);
            files.push(ProjectSummaryEntry {
                path: rel.clone(),
                kind: "file".to_string(),
            });
            if snippets.len() < PROJECT_SUMMARY_MAX_SNIPPETS && should_snippet(&rel) {
                match fs::read(&path) {
                    Ok(bytes) => {
                        let truncated = bytes.len() > PROJECT_SUMMARY_SNIPPET_BYTES;
                        let take = bytes.len().min(PROJECT_SUMMARY_SNIPPET_BYTES);
                        let content = String::from_utf8_lossy(&bytes[..take]).to_string();
                        snippets.push(ProjectSummarySnippet { path: rel, content, truncated });
                    }
                    Err(err) => omitted.push(format!("{}: {}", rel, err)),
                }
            }
        }
    }
}

fn should_skip_path(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "dist" | "dist-types" | "build" | "target" | ".git" | ".kiro" | ".vscode" | ".karo"
    )
}

fn should_snippet(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower == "package.json"
        || lower == "pnpm-workspace.yaml"
        || lower.ends_with("vite.config.ts")
        || lower.ends_with("tsconfig.json")
        || lower.ends_with("src/main.ts")
        || lower.ends_with("src/ui/workbench.ts")
        || lower.ends_with("readme.md")
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .trim_start_matches(|c| c == '\\' || c == '/')
        .to_string()
}

#[tauri::command]
async fn shell_provider_probe(
    request: ProviderProbeRequest,
) -> ShellResult<ProviderProbeResponse> {
    let timeout = Duration::from_millis(
        request.timeout_ms.unwrap_or(DEFAULT_PROBE_TIMEOUT_MS),
    );

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|err| ShellError::ProbeFailed {
            code: "client_init_failed".to_string(),
            message: err.to_string(),
        })?;

    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => {
            return Err(ShellError::ProbeFailed {
                code: "invalid_request".to_string(),
                message: format!("unsupported HTTP method \"{other}\""),
            });
        }
    };

    let mut builder = client.request(method, &request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|err| {
        let code = if err.is_timeout() {
            "request_timeout"
        } else if err.is_connect() {
            "provider_unreachable"
        } else {
            "transport_error"
        };
        ShellError::ProbeFailed {
            code: code.to_string(),
            message: err.to_string(),
        }
    })?;

    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let body = response.text().await.unwrap_or_default();

    Ok(ProviderProbeResponse { status, ok, body })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                PathBuf::from("./app_data")
            });
            let storage = storage::Storage::new(app_data_dir);
            app.manage(AppState {
                storage,
                terminal: terminal::TerminalManager::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::shell_get_device_id,
            commands::shell_read_local_setting,
            commands::shell_write_local_setting,
            commands::shell_delete_local_setting,
            commands::shell_encrypt_local_secret,
            commands::shell_decrypt_local_secret,
            commands::shell_write_local_log,
            commands::shell_export_file,
            commands::shell_show_notification,
            commands::shell_open_preview_file,
            shell_validate_folder_path,
            shell_read_project_summary,
            shell_provider_probe,
            commands::shell_read_file,
            commands::shell_write_staged_file,
            commands::shell_get_staged_changes,
            commands::shell_apply_staged_changes,
            commands::shell_create_task_run,
            commands::shell_update_task_run,
            commands::shell_get_task_run,
            commands::shell_list_task_runs,
            commands::shell_add_agent_run,
            commands::shell_add_artifact,
            context::shell_scan_project_context,
            context::shell_build_task_context,
            terminal::shell_start_command,
            terminal::shell_stop_command,
            terminal::shell_get_command_output,
            terminal::shell_clear_command_output,
            terminal::shell_get_terminal_status,
            terminal::shell_get_terminal_profiles,
            runtime::runtime_detect_project_kind,
            runtime::runtime_create_run,
            runtime::runtime_update_run,
            runtime::runtime_get_run,
            runtime::runtime_list_runs,
            runtime::runtime_append_event,
            runtime::runtime_record_artifact,
            runtime::runtime_record_validation,
            runtime::runtime_get_recovery_state,
            runtime::runtime_apply_run_artifacts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
