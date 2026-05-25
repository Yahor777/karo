use crate::errors::{ShellError, ShellResult};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    child: Arc<Mutex<Child>>,
    status: Arc<Mutex<TerminalStatus>>,
    exit_code: Arc<Mutex<Option<i32>>>,
    output: Arc<Mutex<Vec<TerminalOutputLine>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalStatus {
    Idle,
    Running,
    Exited,
    Error,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputLine {
    pub stream: String,
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub session_id: String,
    pub status: TerminalStatus,
    pub allowed: bool,
    pub profile_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
    pub lines: Vec<TerminalOutputLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusResult {
    pub session_id: Option<String>,
    pub status: TerminalStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub label: String,
    pub shell: String,
    pub available: bool,
}

pub fn is_allowed_mvp_terminal_command(command: &str) -> bool {
    let normalized = normalize_command(command);
    matches!(
        normalized.as_str(),
        "pnpm dev"
            | "pnpm desktop:dev"
            | "pnpm desktop:dev:renderer"
            | "pnpm preview"
            | "pnpm --filter @ai-agent-orchestrator/desktop-windows desktop:dev"
            | "npm run dev"
            | "npm start"
            | "npm run preview"
            | "yarn dev"
            | "pnpm test"
            | "pnpm --filter @ai-agent-orchestrator/desktop-windows exec tsc --noemit"
            | "pnpm --filter @ai-agent-orchestrator/desktop-windows exec tsc --noEmit"
            | "cargo check"
            | "cargo test"
            | "pwd"
            | "dir"
            | "ls"
            | "git status"
            | "pnpm --version"
    )
}

pub fn is_destructive_command(command: &str) -> bool {
    let normalized = normalize_command(command).to_lowercase();
    normalized.contains("git clean -fdx")
        || normalized.contains("rm -rf")
        || normalized.contains("del /s")
        || normalized.contains("remove-item -recurse -force")
        || normalized.contains("format ")
        || normalized == "format"
        || normalized.contains("diskpart")
}

pub fn validate_terminal_command(project_root: &str, command: &str) -> ShellResult<PathBuf> {
    if is_destructive_command(command) {
        return Err(ShellError::PermissionDenied {
            message: "Command blocked by MVP terminal policy: destructive commands are not executable from Preview/Terminal.".to_string(),
        });
    }
    if !is_allowed_mvp_terminal_command(command) {
        return Err(ShellError::PermissionDenied {
            message: "Command requires approval or is not allowed in the MVP terminal allowlist.".to_string(),
        });
    }
    let root = PathBuf::from(project_root);
    if !root.exists() || !root.is_dir() {
        return Err(ShellError::PermissionDenied {
            message: "Project root must exist and be a directory before running a terminal command.".to_string(),
        });
    }
    Ok(root)
}

pub fn detect_terminal_profiles() -> Vec<TerminalProfile> {
    if cfg!(windows) {
        let mut profiles = vec![
            TerminalProfile {
                id: "powershell".to_string(),
                label: "PowerShell".to_string(),
                shell: "powershell.exe".to_string(),
                available: true,
            },
            TerminalProfile {
                id: "cmd".to_string(),
                label: "CMD".to_string(),
                shell: "cmd.exe".to_string(),
                available: true,
            },
        ];
        let git_bash = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
        profiles.push(TerminalProfile {
            id: "git_bash".to_string(),
            label: "Git Bash".to_string(),
            shell: git_bash.to_string_lossy().to_string(),
            available: git_bash.exists(),
        });
        let wsl = PathBuf::from(r"C:\Windows\System32\wsl.exe");
        profiles.push(TerminalProfile {
            id: "wsl".to_string(),
            label: "WSL".to_string(),
            shell: wsl.to_string_lossy().to_string(),
            available: wsl.exists(),
        });
        profiles
    } else if cfg!(target_os = "macos") {
        vec![
            TerminalProfile {
                id: "zsh".to_string(),
                label: "zsh".to_string(),
                shell: "zsh".to_string(),
                available: true,
            },
            TerminalProfile {
                id: "bash".to_string(),
                label: "bash".to_string(),
                shell: "bash".to_string(),
                available: true,
            },
            TerminalProfile {
                id: "sh".to_string(),
                label: "sh".to_string(),
                shell: "sh".to_string(),
                available: true,
            },
        ]
    } else {
        vec![
            TerminalProfile {
                id: "bash".to_string(),
                label: "bash".to_string(),
                shell: "bash".to_string(),
                available: true,
            },
            TerminalProfile {
                id: "zsh".to_string(),
                label: "zsh".to_string(),
                shell: "zsh".to_string(),
                available: true,
            },
            TerminalProfile {
                id: "sh".to_string(),
                label: "sh".to_string(),
                shell: "sh".to_string(),
                available: true,
            },
        ]
    }
}

fn default_profile_id() -> String {
    detect_terminal_profiles()
        .into_iter()
        .find(|profile| profile.available)
        .map(|profile| profile.id)
        .unwrap_or_else(|| "sh".to_string())
}

fn resolve_profile(profile_id: Option<String>) -> ShellResult<TerminalProfile> {
    let requested = profile_id.unwrap_or_else(default_profile_id);
    detect_terminal_profiles()
        .into_iter()
        .find(|profile| profile.id == requested && profile.available)
        .ok_or_else(|| ShellError::PermissionDenied {
            message: format!("Terminal profile \"{}\" is not available on this system.", requested),
        })
}

#[tauri::command]
pub fn shell_start_command(
    state: State<'_, AppState>,
    project_root: String,
    command: String,
    mode: String,
    profile_id: Option<String>,
) -> ShellResult<TerminalStartResult> {
    state.terminal.start_command(project_root, command, mode, profile_id)
}

#[tauri::command]
pub fn shell_get_terminal_profiles() -> ShellResult<Vec<TerminalProfile>> {
    Ok(detect_terminal_profiles())
}

#[tauri::command]
pub fn shell_stop_command(
    state: State<'_, AppState>,
    session_id: String,
) -> ShellResult<TerminalOutput> {
    state.terminal.stop_command(session_id)
}

#[tauri::command]
pub fn shell_get_command_output(
    state: State<'_, AppState>,
    session_id: String,
) -> ShellResult<TerminalOutput> {
    state.terminal.get_output(session_id)
}

#[tauri::command]
pub fn shell_clear_command_output(
    state: State<'_, AppState>,
    session_id: String,
) -> ShellResult<()> {
    state.terminal.clear_output(session_id)
}

#[tauri::command]
pub fn shell_get_terminal_status(state: State<'_, AppState>) -> ShellResult<TerminalStatusResult> {
    state.terminal.status()
}

impl TerminalManager {
    pub fn start_command(
        &self,
        project_root: String,
        command: String,
        mode: String,
        profile_id: Option<String>,
    ) -> ShellResult<TerminalStartResult> {
        let _ = mode;
        let cwd = validate_terminal_command(&project_root, &command)?;
        let profile = resolve_profile(profile_id)?;
        let session_id = format!("term-{}", now_millis());
        let output = Arc::new(Mutex::new(Vec::<TerminalOutputLine>::new()));
        let status = Arc::new(Mutex::new(TerminalStatus::Running));
        let exit_code = Arc::new(Mutex::new(None));

        let mut command_builder = command_for_profile(&profile, &command);
        let mut child = command_builder
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        if let Some(stdout) = child.stdout.take() {
            spawn_reader("stdout", stdout, Arc::clone(&output));
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_reader("stderr", stderr, Arc::clone(&output));
        }

        let child = Arc::new(Mutex::new(child));
        self.sessions.lock().map_err(lock_err)?.insert(
            session_id.clone(),
            TerminalSession {
                child,
                status,
                exit_code,
                output,
            },
        );

        Ok(TerminalStartResult {
            session_id,
            status: TerminalStatus::Running,
            allowed: true,
            profile_id: profile.id,
            reason: None,
        })
    }

    pub fn stop_command(&self, session_id: String) -> ShellResult<TerminalOutput> {
        let sessions = self.sessions.lock().map_err(lock_err)?;
        let session = sessions.get(&session_id).ok_or_else(|| ShellError::PermissionDenied {
            message: "Terminal session not found.".to_string(),
        })?;
        let mut child = session.child.lock().map_err(lock_err)?;
        kill_child_process_tree(&mut child);
        let status = child.wait().ok();
        if let Some(status) = status {
            *session.exit_code.lock().map_err(lock_err)? = status.code();
        }
        *session.status.lock().map_err(lock_err)? = TerminalStatus::Exited;
        drop(child);
        self.output_for_session(&session_id)
    }

    pub fn get_output(&self, session_id: String) -> ShellResult<TerminalOutput> {
        self.refresh_status(&session_id)?;
        self.output_for_session(&session_id)
    }

    pub fn clear_output(&self, session_id: String) -> ShellResult<()> {
        let sessions = self.sessions.lock().map_err(lock_err)?;
        let session = sessions.get(&session_id).ok_or_else(|| ShellError::PermissionDenied {
            message: "Terminal session not found.".to_string(),
        })?;
        session.output.lock().map_err(lock_err)?.clear();
        Ok(())
    }

    pub fn status(&self) -> ShellResult<TerminalStatusResult> {
        let sessions = self.sessions.lock().map_err(lock_err)?;
        let latest = sessions.keys().last().cloned();
        drop(sessions);
        if let Some(session_id) = latest {
            self.refresh_status(&session_id)?;
            let sessions = self.sessions.lock().map_err(lock_err)?;
            let status = sessions
                .get(&session_id)
                .and_then(|session| session.status.lock().ok().map(|s| s.clone()))
                .unwrap_or(TerminalStatus::Error);
            Ok(TerminalStatusResult {
                session_id: Some(session_id),
                status,
            })
        } else {
            Ok(TerminalStatusResult {
                session_id: None,
                status: TerminalStatus::Idle,
            })
        }
    }

    fn refresh_status(&self, session_id: &str) -> ShellResult<()> {
        let sessions = self.sessions.lock().map_err(lock_err)?;
        let session = match sessions.get(session_id) {
            Some(session) => session,
            None => return Ok(()),
        };
        let mut child = session.child.lock().map_err(lock_err)?;
        if let Some(status) = child.try_wait()? {
            *session.exit_code.lock().map_err(lock_err)? = status.code();
            *session.status.lock().map_err(lock_err)? = if status.success() {
                TerminalStatus::Exited
            } else {
                TerminalStatus::Error
            };
        }
        Ok(())
    }

    fn output_for_session(&self, session_id: &str) -> ShellResult<TerminalOutput> {
        let sessions = self.sessions.lock().map_err(lock_err)?;
        let session = sessions.get(session_id).ok_or_else(|| ShellError::PermissionDenied {
            message: "Terminal session not found.".to_string(),
        })?;
        let status = session.status.lock().map_err(lock_err)?.clone();
        let exit_code = *session.exit_code.lock().map_err(lock_err)?;
        let lines = session.output.lock().map_err(lock_err)?.clone();
        Ok(TerminalOutput {
            session_id: session_id.to_string(),
            status,
            exit_code,
            lines,
        })
    }
}

fn command_for_profile(profile: &TerminalProfile, command: &str) -> Command {
    if cfg!(windows) {
        match profile.id.as_str() {
            "powershell" => {
                let mut cmd = Command::new("powershell.exe");
                cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
                cmd
            }
            "cmd" => {
                let mut cmd = Command::new("cmd.exe");
                cmd.args(["/C", command]);
                cmd
            }
            "git_bash" => {
                let mut cmd = Command::new(&profile.shell);
                cmd.args(["-lc", command]);
                cmd
            }
            "wsl" => {
                let mut cmd = Command::new(&profile.shell);
                cmd.args(["sh", "-lc", command]);
                cmd
            }
            _ => {
                let mut cmd = Command::new("powershell.exe");
                cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
                cmd
            }
        }
    } else {
        let shell = match profile.id.as_str() {
            "zsh" => "zsh",
            "bash" => "bash",
            _ => "sh",
        };
        let mut cmd = Command::new(shell);
        cmd.args(["-lc", command]);
        cmd
    }
}

fn spawn_reader<R>(stream: &'static str, reader: R, output: Arc<Mutex<Vec<TerminalOutputLine>>>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut output) = output.lock() {
                output.push(TerminalOutputLine {
                    stream: stream.to_string(),
                    text: line,
                    at: now_isoish(),
                });
                if output.len() > 2_000 {
                    let excess = output.len() - 2_000;
                    output.drain(0..excess);
                }
            }
        }
    });
}

fn kill_child_process_tree(child: &mut Child) {
    if cfg!(windows) {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let _ = child.kill();
    }
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_isoish() -> String {
    format!("{}", now_millis())
}

fn lock_err<T>(err: std::sync::PoisonError<T>) -> ShellError {
    ShellError::StorageError {
        message: format!("Terminal lock poisoned: {}", err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn blocks_destructive_commands() {
        assert!(is_destructive_command("git clean -fdx"));
        assert!(is_destructive_command("Remove-Item -Recurse -Force ."));
        assert!(!is_destructive_command("pnpm test"));
    }

    #[test]
    fn allowlist_accepts_mvp_commands() {
        assert!(is_allowed_mvp_terminal_command("pnpm test"));
        assert!(is_allowed_mvp_terminal_command("pnpm desktop:dev"));
        assert!(is_allowed_mvp_terminal_command("npm run dev"));
        assert!(is_allowed_mvp_terminal_command("npm start"));
        assert!(is_allowed_mvp_terminal_command("npm run preview"));
        assert!(is_allowed_mvp_terminal_command("yarn dev"));
        assert!(is_allowed_mvp_terminal_command("cargo check"));
        assert!(is_allowed_mvp_terminal_command("pwd"));
        assert!(is_allowed_mvp_terminal_command("dir"));
        assert!(is_allowed_mvp_terminal_command("ls"));
        assert!(is_allowed_mvp_terminal_command("git status"));
        assert!(is_allowed_mvp_terminal_command("pnpm --version"));
        assert!(!is_allowed_mvp_terminal_command("echo hello"));
    }

    #[test]
    fn detects_at_least_one_available_terminal_profile() {
        let profiles = detect_terminal_profiles();
        assert!(profiles.iter().any(|profile| profile.available));
        if cfg!(windows) {
            assert!(profiles.iter().any(|profile| profile.id == "powershell"));
            assert!(profiles.iter().any(|profile| profile.id == "cmd"));
            assert!(profiles.iter().any(|profile| profile.id == "git_bash"));
            assert!(profiles.iter().any(|profile| profile.id == "wsl"));
        }
    }

    #[test]
    fn validates_project_root() {
        let temp = tempfile::tempdir().unwrap();
        let ok = validate_terminal_command(temp.path().to_string_lossy().as_ref(), "pnpm test");
        assert!(ok.is_ok());
        let blocked = validate_terminal_command(temp.path().to_string_lossy().as_ref(), "git clean -fdx");
        assert!(blocked.is_err());
    }

    #[test]
    fn terminal_manager_runs_allowed_command_and_captures_output() {
        let manager = TerminalManager::default();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let start = manager
            .start_command(
                root.to_string_lossy().to_string(),
                "cargo check".to_string(),
                "manual".to_string(),
                None,
            )
            .expect("allowed command should start");
        assert_eq!(start.status, TerminalStatus::Running);

        for _ in 0..90 {
            let output = manager
                .get_output(start.session_id.clone())
                .expect("terminal output should be readable");
            if output.status != TerminalStatus::Running {
                let rendered = output
                    .lines
                    .iter()
                    .map(|line| line.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                assert!(
                    rendered.contains("Finished") || rendered.contains("Checking") || !rendered.trim().is_empty(),
                    "expected cargo output, got: {rendered}"
                );
                return;
            }
            sleep(Duration::from_millis(500));
        }

        let _ = manager.stop_command(start.session_id);
        panic!("cargo check terminal smoke did not finish in time");
    }
}
