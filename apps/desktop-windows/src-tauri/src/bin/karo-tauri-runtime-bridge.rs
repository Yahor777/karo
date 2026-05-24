#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("karo-tauri-runtime-bridge is available only in debug/dev/test builds.");
    std::process::exit(2);
}

#[cfg(debug_assertions)]
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(debug_assertions)]
fn run() -> Result<(), String> {
    use ai_agent_orchestrator_desktop_lib::context::{
        shell_build_task_context, BuildTaskContextOptions,
    };
    use serde::Serialize;
    use std::env;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SelectedFileProbe {
        relative_path: String,
        content: String,
        content_chars: usize,
        size_bytes: u64,
        score: f32,
        reason: Vec<String>,
        truncated: bool,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RuntimeBridgeProbe {
        ok: bool,
        bridge: &'static str,
        dev_only: bool,
        context_engine_source: &'static str,
        project_root: String,
        prompt: String,
        scanned_files_count: usize,
        selected_files_count: usize,
        selected_files: Vec<SelectedFileProbe>,
        warnings: Vec<String>,
    }

    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut project_root: Option<String> = None;
    let mut prompt: Option<String> = None;
    let mut max_files = 12usize;
    let mut max_total_chars = 80_000usize;

    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--project-root" => {
                index += 1;
                project_root = args.get(index).cloned();
            }
            "--prompt" => {
                index += 1;
                prompt = args.get(index).cloned();
            }
            "--max-files" => {
                index += 1;
                max_files = args
                    .get(index)
                    .ok_or_else(|| "--max-files requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|error| format!("invalid --max-files: {error}"))?;
            }
            "--max-total-chars" => {
                index += 1;
                max_total_chars = args
                    .get(index)
                    .ok_or_else(|| "--max-total-chars requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|error| format!("invalid --max-total-chars: {error}"))?;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: karo-tauri-runtime-bridge --project-root <path> --prompt <prompt> [--max-files 12] [--max-total-chars 80000]"
                );
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}")),
        }
        index += 1;
    }

    let project_root = project_root.ok_or_else(|| "--project-root is required".to_string())?;
    let prompt = prompt.ok_or_else(|| "--prompt is required".to_string())?;

    let package = shell_build_task_context(
        project_root,
        prompt,
        Some(BuildTaskContextOptions {
            max_files: Some(max_files),
            max_total_chars: Some(max_total_chars),
            include_content: Some(true),
            include_file_tree: Some(true),
            selected_files: None,
            current_file: None,
        }),
    )
    .map_err(|error| format!("{error}"))?;

    let selected_files = package
        .selected_files
        .iter()
        .map(|file| SelectedFileProbe {
            relative_path: file.relative_path.clone(),
            content: file.content.clone(),
            content_chars: file.content.chars().count(),
            size_bytes: file.size_bytes,
            score: file.score,
            reason: file.reason.clone(),
            truncated: file.truncated,
        })
        .collect::<Vec<_>>();

    let probe = RuntimeBridgeProbe {
        ok: true,
        bridge: "karo-tauri-runtime-bridge",
        dev_only: true,
        context_engine_source: "rust_native_tauri_command_impl",
        project_root: package.project_root,
        prompt: package.prompt,
        scanned_files_count: package.scanned_files_count,
        selected_files_count: package.selected_files_count,
        selected_files,
        warnings: package.warnings,
    };

    let json = serde_json::to_string_pretty(&probe)
        .map_err(|error| format!("failed to serialize probe result: {error}"))?;
    println!("{json}");
    Ok(())
}
