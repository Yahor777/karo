use crate::apply::apply_staged_changes_impl;
use crate::errors::{ShellError, ShellResult};
use crate::tasks::ApplyResult;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    StaticSite,
    NodeWeb,
    TauriDesktop,
    MinecraftModGradle,
    Rust,
    Generic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProjectProfile {
    pub project_root: String,
    pub project_kind: ProjectKind,
    pub signals: Vec<String>,
    pub validation_commands: Vec<String>,
    pub preview_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRunMode {
    Auto,
    Chat,
    Plan,
    Agent,
    QuickEdit,
    Assist,
    Safety,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRunStatus {
    Created,
    Running,
    WaitingInput,
    Completed,
    StoppedLimit,
    Error,
    Applied,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventKind {
    Router,
    Context,
    Plan,
    Implement,
    Validate,
    Review,
    Recover,
    Apply,
    Terminal,
    Preview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub id: String,
    pub run_id: String,
    pub sequence: u32,
    pub kind: RuntimeEventKind,
    pub stage: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub at: String,
    #[serde(default)]
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifactRecord {
    pub id: String,
    pub run_id: String,
    pub file_name: String,
    pub latest_version: u32,
    pub content_hash: String,
    pub authored_by: String,
    pub diff_status: String,
    pub validation_status: String,
    pub apply_status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeValidationRecord {
    pub id: String,
    pub run_id: String,
    pub command: String,
    pub project_kind: ProjectKind,
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    pub output_excerpt: String,
    pub can_retry: bool,
    pub recovery_hint: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRecoveryState {
    pub run_id: String,
    pub failed_stage: String,
    pub status: String,
    pub user_message: String,
    pub preserved_artifacts: Vec<String>,
    pub actions: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTaskRun {
    pub id: String,
    pub prompt: String,
    pub mode: RuntimeRunMode,
    pub project_root: String,
    pub project_kind: ProjectKind,
    pub status: RuntimeRunStatus,
    pub active_stage: String,
    pub permission_profile: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub staged_artifacts: Vec<RuntimeArtifactRecord>,
    #[serde(default)]
    pub validations: Vec<RuntimeValidationRecord>,
    #[serde(default)]
    pub recovery_state: Option<RuntimeRecoveryState>,
    #[serde(default)]
    pub terminal_sessions: Vec<String>,
    #[serde(default)]
    pub usage_summary: Option<serde_json::Value>,
    #[serde(default)]
    pub events: Vec<RuntimeEvent>,
}

#[tauri::command]
pub fn runtime_detect_project_kind(project_path: String) -> ShellResult<RuntimeProjectProfile> {
    detect_project_profile(&project_path)
}

#[tauri::command]
pub fn runtime_create_run(state: State<'_, AppState>, run: RuntimeTaskRun) -> ShellResult<()> {
    write_run(&runtime_root(&state.storage.app_data_dir)?, &run)
}

#[tauri::command]
pub fn runtime_update_run(state: State<'_, AppState>, run: RuntimeTaskRun) -> ShellResult<()> {
    write_run(&runtime_root(&state.storage.app_data_dir)?, &run)
}

#[tauri::command]
pub fn runtime_get_run(
    state: State<'_, AppState>,
    run_id: String,
) -> ShellResult<Option<RuntimeTaskRun>> {
    read_run(&runtime_root(&state.storage.app_data_dir)?, &run_id)
}

#[tauri::command]
pub fn runtime_list_runs(
    state: State<'_, AppState>,
    project_path: String,
) -> ShellResult<Vec<RuntimeTaskRun>> {
    let root = runtime_root(&state.storage.app_data_dir)?;
    let runs_dir = root.join("runs");
    if !runs_dir.exists() {
        return Ok(Vec::new());
    }
    let requested = normalize_project_path_for_compare(&project_path);
    let mut runs = Vec::new();
    for entry in fs::read_dir(runs_dir)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        if let Some(run) = read_run(&root, &entry.file_name().to_string_lossy())? {
            if requested.is_empty() || normalize_project_path_for_compare(&run.project_root) == requested {
                runs.push(run);
            }
        }
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(runs)
}

#[tauri::command]
pub fn runtime_append_event(
    state: State<'_, AppState>,
    run_id: String,
    event: RuntimeEvent,
) -> ShellResult<RuntimeTaskRun> {
    let root = runtime_root(&state.storage.app_data_dir)?;
    let mut run = require_run(&root, &run_id)?;
    append_event_record(&root, &event)?;
    run.events.push(event.clone());
    run.active_stage = event.stage;
    run.updated_at = event.at;
    run.status = match event.status.as_str() {
        "error" => RuntimeRunStatus::Error,
        "blocked" => RuntimeRunStatus::WaitingInput,
        "finished" | "completed" => run.status,
        _ => RuntimeRunStatus::Running,
    };
    write_run(&root, &run)?;
    Ok(run)
}

#[tauri::command]
pub fn runtime_record_artifact(
    state: State<'_, AppState>,
    run_id: String,
    artifact: RuntimeArtifactRecord,
) -> ShellResult<RuntimeTaskRun> {
    let root = runtime_root(&state.storage.app_data_dir)?;
    let mut run = require_run(&root, &run_id)?;
    run.staged_artifacts.retain(|item| item.id != artifact.id);
    run.staged_artifacts.push(artifact.clone());
    run.updated_at = artifact.updated_at;
    write_run(&root, &run)?;
    Ok(run)
}

#[tauri::command]
pub fn runtime_record_validation(
    state: State<'_, AppState>,
    run_id: String,
    validation: RuntimeValidationRecord,
) -> ShellResult<RuntimeTaskRun> {
    let root = runtime_root(&state.storage.app_data_dir)?;
    let mut run = require_run(&root, &run_id)?;
    run.validations.retain(|item| item.id != validation.id);
    run.validations.push(validation.clone());
    run.updated_at = validation.created_at.clone();
    if validation.status == "failed" {
        run.recovery_state = Some(RuntimeRecoveryState {
            run_id: run_id.clone(),
            failed_stage: "validate".to_string(),
            status: "needs_recovery".to_string(),
            user_message: "Validation failed. Karo preserved staged artifacts and did not mark the run successful.".to_string(),
            preserved_artifacts: run
                .staged_artifacts
                .iter()
                .map(|artifact| artifact.file_name.clone())
                .collect(),
            actions: vec![
                "Retry validation".to_string(),
                "Open Terminal evidence".to_string(),
                "Continue from staged artifacts".to_string(),
            ],
            updated_at: validation.created_at.clone(),
        });
        run.status = RuntimeRunStatus::Error;
    }
    write_run(&root, &run)?;
    Ok(run)
}

#[tauri::command]
pub fn runtime_get_recovery_state(
    state: State<'_, AppState>,
    run_id: String,
) -> ShellResult<Option<RuntimeRecoveryState>> {
    Ok(read_run(&runtime_root(&state.storage.app_data_dir)?, &run_id)?
        .and_then(|run| run.recovery_state))
}

#[tauri::command]
pub fn runtime_apply_run_artifacts(
    state: State<'_, AppState>,
    project_path: String,
    run_id: String,
    approval: bool,
) -> ShellResult<ApplyResult> {
    if !approval {
        return Err(ShellError::PermissionDenied {
            message: "Runtime v2 apply requires explicit user approval.".to_string(),
        });
    }
    let result = apply_staged_changes_impl(&project_path, &run_id)?;
    let root = runtime_root(&state.storage.app_data_dir)?;
    if let Some(mut run) = read_run(&root, &run_id)? {
        let now = now_millis_string();
        run.status = if result.success {
            RuntimeRunStatus::Applied
        } else {
            RuntimeRunStatus::Error
        };
        run.updated_at = now.clone();
        run.staged_artifacts = run
            .staged_artifacts
            .into_iter()
            .map(|artifact| RuntimeArtifactRecord {
                apply_status: if result.success {
                    "applied".to_string()
                } else {
                    "failed".to_string()
                },
                ..artifact
            })
            .collect();
        let event = RuntimeEvent {
            id: format!("evt-{}-apply", run_id),
            run_id: run_id.clone(),
            sequence: next_sequence(&run),
            kind: RuntimeEventKind::Apply,
            stage: "apply".to_string(),
            title: if result.success {
                "Apply completed".to_string()
            } else {
                "Apply failed".to_string()
            },
            summary: if result.success {
                "Staged artifacts were written after explicit approval.".to_string()
            } else {
                "Apply did not complete. Inspect the errors before retrying.".to_string()
            },
            status: if result.success { "finished" } else { "error" }.to_string(),
            at: now,
            evidence: result
                .changed_files
                .iter()
                .chain(result.created_files.iter())
                .cloned()
                .collect(),
        };
        append_event_record(&root, &event)?;
        run.events.push(event);
        write_run(&root, &run)?;
    }
    Ok(result)
}

pub fn detect_project_profile(project_path: &str) -> ShellResult<RuntimeProjectProfile> {
    let root = PathBuf::from(project_path);
    if !project_path.trim().is_empty() && (!root.exists() || !root.is_dir()) {
        return Err(ShellError::InvalidPath {
            message: "Project root must exist before Runtime v2 can profile it.".to_string(),
        });
    }
    let signals = project_signals(&root);
    let kind = classify_project_kind(&signals);
    Ok(RuntimeProjectProfile {
        project_root: root.to_string_lossy().to_string(),
        validation_commands: validation_commands_for_kind(&kind),
        preview_kind: preview_kind_for_kind(&kind).to_string(),
        project_kind: kind,
        signals,
    })
}

fn runtime_root(app_data_dir: &Path) -> ShellResult<PathBuf> {
    let root = app_data_dir.join("runtime_v2");
    fs::create_dir_all(root.join("runs"))?;
    Ok(root)
}

fn run_dir(root: &Path, run_id: &str) -> PathBuf {
    root.join("runs").join(sanitize_run_id(run_id))
}

fn write_run(root: &Path, run: &RuntimeTaskRun) -> ShellResult<()> {
    let dir = run_dir(root, &run.id);
    fs::create_dir_all(&dir)?;
    let serialized = serde_json::to_string_pretty(run)
        .map_err(|err| ShellError::StorageError { message: err.to_string() })?;
    fs::write(dir.join("run.json"), serialized)?;
    Ok(())
}

fn read_run(root: &Path, run_id: &str) -> ShellResult<Option<RuntimeTaskRun>> {
    let path = run_dir(root, run_id).join("run.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)?;
    let run = serde_json::from_str(&content)
        .map_err(|err| ShellError::StorageError { message: err.to_string() })?;
    Ok(Some(run))
}

fn require_run(root: &Path, run_id: &str) -> ShellResult<RuntimeTaskRun> {
    read_run(root, run_id)?.ok_or_else(|| ShellError::StorageError {
        message: format!("Runtime v2 run not found: {}", run_id),
    })
}

fn append_event_record(root: &Path, event: &RuntimeEvent) -> ShellResult<()> {
    let dir = run_dir(root, &event.run_id);
    fs::create_dir_all(&dir)?;
    let line = serde_json::to_string(event)
        .map_err(|err| ShellError::StorageError { message: err.to_string() })?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("events.jsonl"))?;
    writeln!(file, "{line}")?;
    Ok(())
}

fn sanitize_run_id(run_id: &str) -> String {
    run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
}

fn project_signals(root: &Path) -> Vec<String> {
    if root.as_os_str().is_empty() {
        return Vec::new();
    }
    let mut signals = Vec::new();
    for candidate in [
        "package.json",
        "vite.config.ts",
        "vite.config.js",
        "src-tauri/tauri.conf.json",
        "Cargo.toml",
        "gradlew",
        "gradlew.bat",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "src/main/resources/META-INF/mods.toml",
        "fabric.mod.json",
        "src/main/java",
        "index.html",
        "styles.css",
    ] {
        if root.join(candidate).exists() {
            signals.push(candidate.replace('\\', "/"));
        }
    }
    signals
}

fn classify_project_kind(signals: &[String]) -> ProjectKind {
    let has = |needle: &str| signals.iter().any(|signal| signal == needle);
    let has_gradle = has("gradlew")
        || has("gradlew.bat")
        || has("build.gradle")
        || has("build.gradle.kts")
        || has("settings.gradle")
        || has("settings.gradle.kts");
    let has_mod_signal = has("src/main/resources/META-INF/mods.toml")
        || has("fabric.mod.json")
        || (has_gradle && has("src/main/java"));
    if has_mod_signal {
        return ProjectKind::MinecraftModGradle;
    }
    if has("src-tauri/tauri.conf.json") {
        return ProjectKind::TauriDesktop;
    }
    if has("Cargo.toml") {
        return ProjectKind::Rust;
    }
    if has("package.json") || has("vite.config.ts") || has("vite.config.js") {
        return ProjectKind::NodeWeb;
    }
    if has("index.html") || has("styles.css") {
        return ProjectKind::StaticSite;
    }
    ProjectKind::Generic
}

fn validation_commands_for_kind(kind: &ProjectKind) -> Vec<String> {
    match kind {
        ProjectKind::MinecraftModGradle => vec![
            ".\\gradlew.bat build".to_string(),
            ".\\gradlew.bat test".to_string(),
            "./gradlew build".to_string(),
            "./gradlew test".to_string(),
        ],
        ProjectKind::TauriDesktop => vec!["pnpm typecheck".to_string(), "cargo check".to_string()],
        ProjectKind::NodeWeb => vec!["pnpm test".to_string(), "pnpm typecheck".to_string()],
        ProjectKind::Rust => vec!["cargo test".to_string(), "cargo check".to_string()],
        ProjectKind::StaticSite => vec!["Open applied index.html in Preview".to_string()],
        ProjectKind::Generic => vec!["git status".to_string()],
    }
}

fn preview_kind_for_kind(kind: &ProjectKind) -> &'static str {
    match kind {
        ProjectKind::StaticSite | ProjectKind::NodeWeb | ProjectKind::TauriDesktop => "browser",
        ProjectKind::MinecraftModGradle | ProjectKind::Rust | ProjectKind::Generic => "validation_evidence",
    }
}

fn normalize_project_path_for_compare(path: &str) -> String {
    if path.trim().is_empty() {
        return String::new();
    }
    fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_ascii_lowercase()
}

fn next_sequence(run: &RuntimeTaskRun) -> u32 {
    run.events.iter().map(|event| event.sequence).max().unwrap_or(0) + 1
}

fn now_millis_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_minecraft_gradle_before_generic_node() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        fs::write(temp.path().join("build.gradle"), "plugins {}").unwrap();
        fs::create_dir_all(temp.path().join("src/main/resources/META-INF")).unwrap();
        fs::write(temp.path().join("src/main/resources/META-INF/mods.toml"), "modLoader='javafml'").unwrap();

        let profile = detect_project_profile(temp.path().to_string_lossy().as_ref()).unwrap();

        assert_eq!(profile.project_kind, ProjectKind::MinecraftModGradle);
        assert_eq!(profile.preview_kind, "validation_evidence");
        assert!(profile.validation_commands.iter().any(|cmd| cmd.contains("gradlew")));
    }

    #[test]
    fn persists_run_and_appends_public_events() {
        let temp = tempfile::tempdir().unwrap();
        let root = runtime_root(temp.path()).unwrap();
        let run = RuntimeTaskRun {
            id: "run-1".to_string(),
            prompt: "implement feature".to_string(),
            mode: RuntimeRunMode::Agent,
            project_root: temp.path().to_string_lossy().to_string(),
            project_kind: ProjectKind::Generic,
            status: RuntimeRunStatus::Created,
            active_stage: "router".to_string(),
            permission_profile: "smart_approval".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            staged_artifacts: vec![],
            validations: vec![],
            recovery_state: None,
            terminal_sessions: vec![],
            usage_summary: None,
            events: vec![],
        };
        write_run(&root, &run).unwrap();
        let event = RuntimeEvent {
            id: "evt-1".to_string(),
            run_id: "run-1".to_string(),
            sequence: 1,
            kind: RuntimeEventKind::Router,
            stage: "router".to_string(),
            title: "Routed to Agent".to_string(),
            summary: "File changes require staged artifacts.".to_string(),
            status: "finished".to_string(),
            at: "2".to_string(),
            evidence: vec!["Apply gate".to_string()],
        };
        append_event_record(&root, &event).unwrap();
        let mut loaded = read_run(&root, "run-1").unwrap().unwrap();
        loaded.events.push(event);
        write_run(&root, &loaded).unwrap();

        let reloaded = read_run(&root, "run-1").unwrap().unwrap();
        assert_eq!(reloaded.events.len(), 1);
        assert_eq!(reloaded.events[0].kind, RuntimeEventKind::Router);
        assert!(root.join("runs/run-1/events.jsonl").exists());
    }
}
