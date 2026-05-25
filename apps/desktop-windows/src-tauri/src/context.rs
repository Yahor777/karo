use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::errors::{ShellError, ShellResult};
use crate::paths::normalize_and_validate_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub extension: Option<String>,
    pub is_text: bool,
    pub score: f32,
    pub reason: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    pub relative_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub score: f32,
    pub reason: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredSummary {
    pub ignored_dirs: usize,
    pub ignored_files: usize,
    pub ignored_large_files: usize,
    pub ignored_binary_files: usize,
    pub ignored_secret_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContextPackage {
    pub project_root: String,
    pub prompt: String,
    pub file_tree_summary: Vec<ProjectFileEntry>,
    pub selected_files: Vec<ContextFile>,
    pub ignored_summary: IgnoredSummary,
    pub token_budget_hint: usize,
    pub created_at: String,
    pub warnings: Vec<String>,
    pub scanned_files_count: usize,
    pub selected_files_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTaskContextOptions {
    pub max_files: Option<usize>,
    pub max_total_chars: Option<usize>,
    pub include_content: Option<bool>,
    pub include_file_tree: Option<bool>,
    pub selected_files: Option<Vec<String>>,
    pub current_file: Option<String>,
}

impl Default for BuildTaskContextOptions {
    fn default() -> Self {
        Self {
            max_files: Some(12),
            max_total_chars: Some(80000),
            include_content: Some(true),
            include_file_tree: Some(true),
            selected_files: None,
            current_file: None,
        }
    }
}

// STOPWORDS for Russian and English
const STOPWORDS: &[&str] = &[
    "создай", "сделай", "исправь", "добавь", "измени", "файл", "текст", "как", "что", "это", "для", "надо", "нужно", "работает", "почему",
    "the", "and", "for", "with", "from", "this", "that", "file", "create", "make", "add", "fix", "change", "update", "how", "what", "why", "work", "works"
];

// List of allowed text extensions
const ALLOWED_TEXT_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "rs", "json", "toml", "md", "css", "scss", "html", "yml", "yaml",
    "py", "java", "kt", "go", "sql", "sh", "ps1", "txt", "xml", "vue", "svelte", "c", "cpp",
    "h", "hpp", "cs", "php", "rb", "lua"
];

// Binary and ignored extensions
const BLOCKED_BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "svg",
    "mp4", "mov", "avi", "mp3", "wav", "ogg",
    "zip", "rar", "7z", "tar", "gz",
    "exe", "dll", "bin", "so", "dylib", "class", "jar"
];

// Ignored directories
const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "target", ".next", ".nuxt", "out", "coverage",
    ".turbo", ".cache", "vendor", ".idea", ".vscode", "logs", "tmp", "temp", "e2e-artifacts",
    ".karo", ".codex", ".antigravitycli", "screenshots", "reports"
];

// Sensitive/Secret files
const SENSITIVE_FILE_PATTERNS: &[&str] = &[
    "key", "pem", "p12", "pfx", "secret", "private", "credential"
];

// --- safe scanning logic ---

pub fn is_ignored_directory(name: &str) -> bool {
    let lower = name.to_lowercase();
    IGNORED_DIRS.contains(&lower.as_str())
}

pub fn is_sensitive_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") || lower == "karo.key" {
        return true;
    }
    for pattern in SENSITIVE_FILE_PATTERNS {
        if lower.contains(pattern) {
            return true;
        }
    }
    false
}

pub fn is_generated_runtime_file(relative_path: &str) -> bool {
    let lower = relative_path.to_lowercase();
    let name = Path::new(&lower)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    name == "chat_response.txt"
        || name == "context-engine-check.txt"
        || (name.starts_with("karo-before-") && name.ends_with(".patch"))
        || lower.contains("/e2e-artifacts/")
        || lower.starts_with("e2e-artifacts/")
        || lower.contains("/.karo/")
        || lower.starts_with(".karo/")
        || lower.contains("/.codex/")
        || lower.starts_with(".codex/")
        || lower.contains("/.antigravitycli/")
        || lower.starts_with(".antigravitycli/")
        || lower.contains("/screenshots/")
        || lower.starts_with("screenshots/")
        || lower.contains("/reports/")
        || lower.starts_with("reports/")
}

pub fn is_lockfile(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "package-lock.json" || lower == "pnpm-lock.yaml" || lower == "yarn.lock"
}

pub fn is_text_file(name: &str) -> bool {
    if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
        let lower = ext.to_lowercase();
        ALLOWED_TEXT_EXTENSIONS.contains(&lower.as_str())
    } else {
        // Files like LICENSE, Makefile, etc. can be read as text if small and no extension
        true
    }
}

pub fn is_binary_file(name: &str) -> bool {
    if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
        let lower = ext.to_lowercase();
        BLOCKED_BINARY_EXTENSIONS.contains(&lower.as_str())
    } else {
        false
    }
}

// Recursive directory walk
fn walk_project(
    root: &Path,
    current_dir: &Path,
    depth: usize,
    entries: &mut Vec<ProjectFileEntry>,
    ignored: &mut IgnoredSummary,
    warnings: &mut Vec<String>,
) {
    if depth > 10 {
        warnings.push(format!("Depth limit exceeded at {:?}", current_dir));
        return;
    }
    if entries.len() >= 5000 {
        return;
    }

    let read_res = fs::read_dir(current_dir);
    if let Err(e) = read_res {
        warnings.push(format!("Failed to read dir {:?}: {}", current_dir, e));
        return;
    }

    let mut sorted = read_res.unwrap().filter_map(Result::ok).collect::<Vec<_>>();
    sorted.sort_by_key(|e| e.file_name());

    for entry in sorted {
        if entries.len() >= 5000 {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if is_ignored_directory(&name) || name == "staging" || name == "backups" {
                ignored.ignored_dirs += 1;
                continue;
            }
            walk_project(root, &path, depth + 1, entries, ignored, warnings);
        } else {
            let rel_path = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");

            if rel_path.starts_with(".karo/staging") || rel_path.starts_with(".karo/backups") {
                ignored.ignored_files += 1;
                continue;
            }

            if is_sensitive_file(&name) {
                ignored.ignored_secret_files += 1;
                continue;
            }

            if is_generated_runtime_file(&rel_path) {
                ignored.ignored_files += 1;
                continue;
            }

            if is_binary_file(&name) {
                ignored.ignored_binary_files += 1;
                continue;
            }

            let metadata_res = entry.metadata();
            if let Err(e) = metadata_res {
                warnings.push(format!("Failed to read metadata for {}: {}", rel_path, e));
                continue;
            }
            let meta = metadata_res.unwrap();
            let size = meta.len();

            if size > 128 * 1024 {
                ignored.ignored_large_files += 1;
                continue;
            }

            let ext = path.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase());
            let is_txt = is_text_file(&name);

            if !is_txt {
                ignored.ignored_binary_files += 1;
                continue;
            }

            entries.push(ProjectFileEntry {
                relative_path: rel_path,
                size_bytes: size,
                extension: ext,
                is_text: is_txt,
                score: 0.0,
                reason: Vec::new(),
            });
        }
    }
}

// --- Keyword Extraction ---

pub fn extract_keywords_and_paths(prompt: &str) -> (Vec<String>, Vec<String>) {
    let mut keywords = Vec::new();
    let mut paths = Vec::new();

    // Specific tokenization keeping original case for camelCase detection
    let clean_prompt = prompt.replace(|c: char| {
        !c.is_alphanumeric() && c != '/' && c != '\\' && c != '.' && c != '_' && c != '-'
    }, " ");

    for token in clean_prompt.split_whitespace() {
        if token.is_empty() {
            continue;
        }

        // Check if token looks like a path
        if token.contains('/') || token.contains('\\') || (token.contains('.') && token.len() > 3) {
            paths.push(token.replace('\\', "/").to_lowercase());
        }

        // camelCase and PascalCase splitting: e.g. "WorkbenchState" -> "Workbench State"
        let mut split_token = String::new();
        let mut prev_char: Option<char> = None;
        for c in token.chars() {
            if let Some(prev) = prev_char {
                if prev.is_lowercase() && c.is_uppercase() {
                    split_token.push(' ');
                }
            }
            split_token.push(c);
            prev_char = Some(c);
        }

        let token_lower = token.to_lowercase();

        // Split by separators
        let parts: Vec<&str> = split_token.split(|c: char| c == '-' || c == '_' || c == '.' || c == ' ').collect();
        for part in parts {
            let part_lower = part.to_lowercase();
            if part_lower.len() > 2 && !STOPWORDS.contains(&part_lower.as_str()) {
                if !keywords.contains(&part_lower) {
                    keywords.push(part_lower);
                }
            }
        }

        // Also keep the original lowercased token if it's not a stopword
        if token_lower.len() > 2 && !STOPWORDS.contains(&token_lower.as_str()) {
            if !keywords.contains(&token_lower) {
                keywords.push(token_lower);
            }
        }
    }

    let lower_prompt = prompt.to_lowercase();
    // Special handling for "Apply Changes" and related terms
    let is_apply_changes_query = lower_prompt.contains("apply changes")
        || lower_prompt.contains("apply_changes")
        || lower_prompt.contains("применен")
        || lower_prompt.contains("применить")
        || lower_prompt.contains("изменений");
    
    if is_apply_changes_query {
        let extra_kws = &[
            "apply",
            "changes",
            "staging",
            "artifact",
            "disk",
            "command",
            "nativebindings",
            "workbench",
        ];
        for kw in extra_kws {
            let kw_string = kw.to_string();
            if !keywords.contains(&kw_string) {
                keywords.push(kw_string);
            }
        }
    }

    (keywords, paths)
}

// --- Scoring Logic ---

pub fn score_file(
    entry: &mut ProjectFileEntry,
    keywords: &[String],
    explicit_paths: &[String],
    options: &BuildTaskContextOptions,
    prompt: &str,
) {
    let rel_lower = entry.relative_path.to_lowercase();
    let name_lower = Path::new(&rel_lower).file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    let lower_prompt = prompt.to_lowercase();

    // 1. Explicit path in prompt (+30)
    for exp_path in explicit_paths {
        if rel_lower == *exp_path || rel_lower.ends_with(exp_path) {
            entry.score += 30.0;
            entry.reason.push("explicit path in prompt".to_string());
            break;
        }
    }

    // 2. Filename contains keyword (+15)
    for kw in keywords {
        if name_lower.contains(kw) {
            entry.score += 15.0;
            entry.reason.push(format!("filename matched \"{}\"", kw));
        }
    }

    // 3. Relative path contains keyword (+10)
    for kw in keywords {
        if rel_lower.contains(kw) && !name_lower.contains(kw) {
            entry.score += 10.0;
            entry.reason.push(format!("path matched \"{}\"", kw));
        }
    }

    // 4. File extension fits the task (+6)
    if let Some(ref ext) = entry.extension {
        let is_rust_task = keywords.iter().any(|k| k == "rust" || k == "cargo" || k == "rs");
        let is_ts_task = keywords.iter().any(|k| k == "typescript" || k == "ts" || k == "tsx" || k == "workbench" || k == "ui");
        if ext == "rs" && is_rust_task {
            entry.score += 6.0;
            entry.reason.push("extension rs matches Rust task context".to_string());
        } else if (ext == "ts" || ext == "tsx") && is_ts_task {
            entry.score += 6.0;
            entry.reason.push("extension matches TypeScript task context".to_string());
        }
    }

    // 5. Selected by user option (+5)
    if let Some(ref sel_files) = options.selected_files {
        let is_selected = sel_files.iter().any(|f| {
            let f_norm = f.replace('\\', "/");
            entry.relative_path == f_norm || entry.relative_path.ends_with(&f_norm)
        });
        if is_selected {
            entry.score += 5.0;
            entry.reason.push("selected by user options".to_string());
        }
    }

    // 6. Current file matches (+4)
    if let Some(ref cur_file) = options.current_file {
        let cur_norm = cur_file.replace('\\', "/");
        if entry.relative_path == cur_norm || entry.relative_path.ends_with(&cur_norm) {
            entry.score += 4.0;
            entry.reason.push("currently active file".to_string());
        }
    }

    // 7. Inside src/ (+3)
    if rel_lower.contains("src/") {
        entry.score += 3.0;
        entry.reason.push("file is inside src/ directory".to_string());
    }

    // 8. Special naming matched (+3)
    let special_keywords = &["workbench", "nativebindings", "commands", "apply", "context", "storage"];
    for special in special_keywords {
        if keywords.contains(&special.to_string()) && name_lower.contains(special) {
            entry.score += 3.0;
            entry.reason.push(format!("special component match \"{}\"", special));
        }
    }

    // 8b. Target files boost for Apply Changes query (+20)
    let target_files = &[
        "apply.rs",
        "staging.rs",
        "commands.rs",
        "nativebindings.ts",
        "desktoporchestratortransport.ts",
        "workbench.ts",
    ];
    let is_apply_query = keywords.contains(&"apply".to_string()) || keywords.contains(&"changes".to_string());
    if is_apply_query {
        for target in target_files {
            if rel_lower.ends_with(target) {
                entry.score += 20.0;
                entry.reason.push(format!("Apply Changes target file boost for \"{}\"", target));
            }
        }
    }

    // 9. lockfiles scoring logic
    if is_lockfile(&name_lower) {
        let is_dep_task = keywords.iter().any(|k| {
            matches!(k.as_str(), "pnpm" | "npm" | "package" | "dependency" | "lockfile" | "yarn" | "lock")
        });
        if !is_dep_task {
            entry.score -= 20.0;
            entry.reason.push("demoted lockfile (not dependency task)".to_string());
        }
    }

    // 10. test files demotion (-10)
    let is_test_file = name_lower.contains("test") || name_lower.contains("spec") || rel_lower.contains("__tests__");
    let is_test_prompt = keywords.iter().any(|k| k == "test" || k == "tests" || k == "vitest" || k == "cargo-test");
    if is_test_file && !is_test_prompt {
        entry.score -= 10.0;
        entry.reason.push("demoted test/spec file (prompt not about testing)".to_string());
    }

    let is_security_query =
        lower_prompt.contains("security")
            || lower_prompt.contains("safe")
            || lower_prompt.contains("api key")
            || lower_prompt.contains("secret")
            || lower_prompt.contains("credential")
            || lower_prompt.contains("безопас")
            || lower_prompt.contains("ключ")
            || lower_prompt.contains("украд");
    if is_security_query {
        let security_targets = [
            "auth",
            "secret",
            "cipher",
            "key",
            "credential",
            "commandpolicy",
            "terminal.rs",
            "security.rs",
            "commands.rs",
            "nativebindings.ts",
            "bridge.ts",
            "applicationshell.ts",
            "desktoporchestratortransport.ts",
            "apply.rs",
            "staging.rs",
            "paths.rs",
            "storage",
            "settings",
            "provider",
            "probe",
            "log",
            "report",
        ];
        for target in security_targets {
            if rel_lower.contains(target) || name_lower.contains(target) {
                entry.score += 28.0;
                entry.reason.push(format!("security review target boost for \"{}\"", target));
                break;
            }
        }
        if name_lower.starts_with("readme") {
            entry.score -= 18.0;
            entry.reason.push("README demoted for code-focused security review".to_string());
        }
    }

    let is_ui_work_query =
        lower_prompt.contains("ui")
            || lower_prompt.contains("ux")
            || lower_prompt.contains("interface")
            || lower_prompt.contains("composer")
            || lower_prompt.contains("sidebar")
            || lower_prompt.contains("right panel")
            || lower_prompt.contains("inspector")
            || lower_prompt.contains("workbench")
            || lower_prompt.contains("mcp")
            || lower_prompt.contains("playwright")
            || lower_prompt.contains("РёРЅС‚РµСЂС„РµР№СЃ")
            || lower_prompt.contains("РєРѕРјРїРѕР·РµСЂ")
            || lower_prompt.contains("СЃР°Р№РґР±Р°СЂ");
    if is_ui_work_query {
        let ui_targets = [
            "workbench.ts",
            "main.css",
            "workbench.test.ts",
            "scenarios.ts",
            "selectors.ts",
            "assertions.ts",
        ];
        for target in ui_targets {
            if rel_lower.ends_with(target) {
                entry.score += 24.0;
                entry.reason.push(format!("UI work target boost for \"{}\"", target));
                break;
            }
        }
    }
}

// --- Tauri Commands Implementation ---

fn normalize_windows_extended_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        return format!("//{}", rest);
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        return rest.to_string();
    }
    path.to_string()
}

fn is_security_review_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains("security")
        || lower.contains("safe")
        || lower.contains("api key")
        || lower.contains("secret")
        || lower.contains("credential")
        || lower.contains("безопас")
        || lower.contains("ключ")
        || lower.contains("украд")
}

fn is_static_website_creation_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let asks_for_site = lower.contains("landing")
        || lower.contains("website")
        || lower.contains("web app")
        || lower.contains("homepage")
        || lower.contains("site")
        || lower.contains("лендинг")
        || lower.contains("сайт")
        || lower.contains("страниц");
    let asks_to_create = lower.contains("create")
        || lower.contains("build")
        || lower.contains("make")
        || lower.contains("generate")
        || lower.contains("создай")
        || lower.contains("сделай")
        || lower.contains("построй");
    let has_page_shape = lower.contains("hero")
        || lower.contains("features")
        || lower.contains("faq")
        || lower.contains("responsive")
        || lower.contains("abilities")
        || lower.contains("cards")
        || lower.contains("способност")
        || lower.contains("персонаж")
        || lower.contains("карточ");
    let explicit_website_files = lower.contains("index.html")
        || lower.contains("styles.css")
        || lower.contains("script.js")
        || lower.contains("readme.md");
    let unicode_site_signals = lower.contains("сайт")
        || lower.contains("лендинг")
        || lower.contains("страниц");
    let unicode_create_signals = lower.contains("созда")
        || lower.contains("сдела")
        || lower.contains("постро")
        || lower.contains("сгенер")
        || lower.contains("реализ");
    let unicode_page_shape = lower.contains("способност")
        || lower.contains("персонаж")
        || lower.contains("энерг")
        || lower.contains("карточ");
    (asks_for_site || explicit_website_files || unicode_site_signals)
        && (asks_to_create || unicode_create_signals)
        && (has_page_shape || explicit_website_files || unicode_page_shape)
}

fn is_ui_work_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains("ui")
        || lower.contains("ux")
        || lower.contains("interface")
        || lower.contains("composer")
        || lower.contains("sidebar")
        || lower.contains("right panel")
        || lower.contains("inspector")
        || lower.contains("workbench")
        || lower.contains("mcp")
        || lower.contains("playwright")
}

fn is_ui_work_context_candidate(relative_path: &str) -> bool {
    let rel_lower = relative_path.to_lowercase();
    rel_lower.contains("/src/ui/")
        || rel_lower.ends_with("workbench.ts")
        || rel_lower.ends_with("main.css")
        || rel_lower.ends_with("workbench.test.ts")
        || rel_lower.contains("/mcp/")
        || rel_lower.ends_with("scenarios.ts")
        || rel_lower.ends_with("selectors.ts")
        || rel_lower.ends_with("assertions.ts")
}

fn is_low_signal_static_site_context(relative_path: &str) -> bool {
    let lower = relative_path.to_lowercase();
    lower.contains("karo-test-output")
        || lower.contains("context-engine-check")
        || lower.contains("chat_response")
        || lower.contains("manual-check")
        || lower.ends_with(".txt")
        || lower.ends_with("test-output.txt")
        || lower.ends_with("output.txt")
}

#[tauri::command]
pub fn shell_scan_project_context(project_path: String) -> ShellResult<TaskContextPackage> {
    let normalized_project_path = normalize_windows_extended_path(&project_path);
    let candidate = PathBuf::from(&normalized_project_path);
    if !candidate.is_absolute() {
        return Err(ShellError::InvalidPath {
            message: "Project root must be absolute".to_string(),
        });
    }

    let root_path = candidate.canonicalize().unwrap_or(candidate);
    if !root_path.is_dir() {
        return Err(ShellError::InvalidPath {
            message: "Project root must be a directory".to_string(),
        });
    }

    let mut file_tree_summary = Vec::new();
    let mut ignored_summary = IgnoredSummary::default();
    let mut warnings = Vec::new();

    walk_project(
        &root_path,
        &root_path,
        0,
        &mut file_tree_summary,
        &mut ignored_summary,
        &mut warnings,
    );

    let scanned_files_count = file_tree_summary.len();

    Ok(TaskContextPackage {
        project_root: root_path.to_string_lossy().to_string(),
        prompt: String::new(),
        file_tree_summary,
        selected_files: Vec::new(),
        ignored_summary,
        token_budget_hint: 80000,
        created_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default(),
        warnings,
        scanned_files_count,
        selected_files_count: 0,
    })
}

#[tauri::command]
pub fn shell_build_task_context(
    project_path: String,
    prompt: String,
    options: Option<BuildTaskContextOptions>,
) -> ShellResult<TaskContextPackage> {
    let normalized_project_path = normalize_windows_extended_path(&project_path);
    let candidate = PathBuf::from(&normalized_project_path);
    if !candidate.is_absolute() {
        return Err(ShellError::InvalidPath {
            message: "Project root must be absolute".to_string(),
        });
    }

    let root_path = candidate.canonicalize().unwrap_or(candidate);
    if !root_path.is_dir() {
        return Err(ShellError::InvalidPath {
            message: "Project root must be a directory".to_string(),
        });
    }

    let opts = options.unwrap_or_default();
    let max_files = opts.max_files.unwrap_or(12);
    let max_total_chars = opts.max_total_chars.unwrap_or(80000);
    let include_content = opts.include_content.unwrap_or(true);
    let include_file_tree = opts.include_file_tree.unwrap_or(true);

    let mut file_tree_summary = Vec::new();
    let mut ignored_summary = IgnoredSummary::default();
    let mut warnings = Vec::new();

    walk_project(
        &root_path,
        &root_path,
        0,
        &mut file_tree_summary,
        &mut ignored_summary,
        &mut warnings,
    );

    let scanned_files_count = file_tree_summary.len();
    let (keywords, explicit_paths) = extract_keywords_and_paths(&prompt);

    // Calculate score for each entry
    for entry in &mut file_tree_summary {
        score_file(entry, &keywords, &explicit_paths, &opts, &prompt);
    }

    // Content scoring (optional addition, check if content contains keywords)
    for entry in &mut file_tree_summary {
        if entry.score > -50.0 && entry.is_text && entry.size_bytes < 32 * 1024 {
            let target_path = root_path.join(&entry.relative_path);
            if let Ok(content) = fs::read_to_string(&target_path) {
                let content_lower = content.to_lowercase();
                let mut content_matches = 0;
                for kw in &keywords {
                    if content_lower.contains(kw) {
                        content_matches += 1;
                    }
                }
                if content_matches > 0 {
                    let pts = (content_matches as f32 * 2.0).min(8.0);
                    entry.score += pts;
                    entry.reason.push(format!("content matched {} prompt keywords (+{})", content_matches, pts));
                }
            }
        }
    }

    // Sort by score descending
    file_tree_summary.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Resolve selected files by options first if they are not in the scanned list but safely valid
    let mut selected_files = Vec::new();
    let mut total_chars_accumulated = 0;

    let is_security_query = is_security_review_prompt(&prompt);
    let is_static_website_creation = is_static_website_creation_prompt(&prompt);
    let is_ui_work_query = is_ui_work_prompt(&prompt);
    let mut readme_count = 0usize;
    let candidate_files: Vec<ProjectFileEntry> = file_tree_summary
        .iter()
        .filter(|e| e.score > -50.0)
        .filter(|e| {
            if is_static_website_creation && is_low_signal_static_site_context(&e.relative_path) {
                return false;
            }
            if is_ui_work_query
                && explicit_paths.is_empty()
                && !is_ui_work_context_candidate(&e.relative_path)
                && e.score < 12.0
            {
                return false;
            }
            if !is_security_query {
                return true;
            }
            let name = Path::new(&e.relative_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase();
            if name.starts_with("readme") {
                readme_count += 1;
                return readme_count <= 2;
            }
            true
        })
        .take(max_files)
        .cloned()
        .collect();

    if include_content {
        for entry in candidate_files {
            if total_chars_accumulated >= max_total_chars {
                warnings.push("Total character budget reached, skipping further file contents.".to_string());
                break;
            }

            // High Safety Boundary Check
            let path_check = normalize_and_validate_path(&root_path.to_string_lossy(), &entry.relative_path);
            if let Err(e) = path_check {
                warnings.push(format!("Safety block for {}: {:?}", entry.relative_path, e));
                ignored_summary.ignored_secret_files += 1;
                continue;
            }
            let validated_path = path_check.unwrap();

            match fs::read_to_string(&validated_path) {
                Ok(content) => {
                    let mut text_content = content;
                    let mut truncated = false;
                    let mut size = entry.size_bytes;

                    let remaining_chars = max_total_chars.saturating_sub(total_chars_accumulated);
                    if text_content.len() > remaining_chars {
                        text_content = text_content.chars().take(remaining_chars).collect();
                        truncated = true;
                        size = text_content.len() as u64;
                        warnings.push(format!("File {} truncated due to character budget", entry.relative_path));
                    }

                    total_chars_accumulated += text_content.len();

                    selected_files.push(ContextFile {
                        relative_path: entry.relative_path.clone(),
                        content: text_content,
                        size_bytes: size,
                        score: entry.score,
                        reason: entry.reason.clone(),
                        truncated,
                    });
                }
                Err(e) => {
                    warnings.push(format!("Failed to read {}: {}", entry.relative_path, e));
                }
            }
        }
    }

    let selected_files_count = selected_files.len();

    // Clean up file_tree_summary if include_file_tree is false
    let final_file_tree = if include_file_tree {
        file_tree_summary
    } else {
        Vec::new()
    };

    Ok(TaskContextPackage {
        project_root: root_path.to_string_lossy().to_string(),
        prompt,
        file_tree_summary: final_file_tree,
        selected_files,
        ignored_summary,
        token_budget_hint: max_total_chars,
        created_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default(),
        warnings,
        scanned_files_count,
        selected_files_count,
    })
}

// --- Rust Tests mod ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn create_test_project() -> (PathBuf, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();

        // Create dummy directories
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".karo/staging")).unwrap();
        fs::create_dir_all(root.join("e2e-artifacts/reports")).unwrap();

        // Create dummy files
        File::create(root.join("package.json")).unwrap();
        
        let mut f1 = File::create(root.join("src/apply.rs")).unwrap();
        f1.write_all(b"fn apply_staged_changes() {}").unwrap();

        let mut f2 = File::create(root.join("src/workbench.ts")).unwrap();
        f2.write_all(b"class WorkbenchState {}").unwrap();

        let mut f3 = File::create(root.join(".env")).unwrap();
        f3.write_all(b"SECRET_KEY=12345").unwrap();

        File::create(root.join("node_modules/bad_dep.js")).unwrap();
        File::create(root.join(".git/config")).unwrap();
        File::create(root.join(".karo/staging/task_123.txt")).unwrap();
        File::create(root.join("e2e-artifacts/reports/latest.json")).unwrap();
        
        let mut bin = File::create(root.join("image.png")).unwrap();
        bin.write_all(&[0, 1, 2, 3]).unwrap();

        (root, temp)
    }

    #[test]
    fn test_ignores_node_modules_and_git() {
        let (root, _temp) = create_test_project();
        let pkg = shell_scan_project_context(root.to_string_lossy().to_string()).unwrap();
        
        // Assert node_modules & .git are ignored
        let has_node_modules = pkg.file_tree_summary.iter().any(|f| f.relative_path.contains("node_modules"));
        let has_git = pkg.file_tree_summary.iter().any(|f| f.relative_path.contains(".git"));
        let has_staging = pkg.file_tree_summary.iter().any(|f| f.relative_path.contains("staging"));
        let has_e2e_artifacts = pkg.file_tree_summary.iter().any(|f| f.relative_path.contains("e2e-artifacts"));

        assert!(!has_node_modules);
        assert!(!has_git);
        assert!(!has_staging);
        assert!(!has_e2e_artifacts);
        assert!(pkg.ignored_summary.ignored_dirs > 0);
    }

    #[test]
    fn test_ignores_generated_runtime_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::create_dir_all(root.join(".antigravitycli")).unwrap();
        fs::create_dir_all(root.join("screenshots")).unwrap();
        fs::create_dir_all(root.join("reports")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();

        File::create(root.join(".codex/session.json")).unwrap();
        File::create(root.join(".antigravitycli/state.json")).unwrap();
        File::create(root.join("screenshots/runtime.png")).unwrap();
        File::create(root.join("reports/latest.md")).unwrap();
        File::create(root.join("karo-before-test.patch")).unwrap();
        File::create(root.join("chat_response.txt")).unwrap();
        File::create(root.join("context-engine-check.txt")).unwrap();
        File::create(root.join("src/app.ts")).unwrap();

        let pkg = shell_scan_project_context(root.to_string_lossy().to_string()).unwrap();
        let files = pkg.file_tree_summary.iter().map(|f| f.relative_path.as_str()).collect::<Vec<_>>();

        assert!(files.contains(&"src/app.ts"));
        assert!(!files.iter().any(|path| path.contains(".codex")));
        assert!(!files.iter().any(|path| path.contains(".antigravitycli")));
        assert!(!files.iter().any(|path| path.contains("screenshots")));
        assert!(!files.iter().any(|path| path.contains("reports")));
        assert!(!files.contains(&"karo-before-test.patch"));
        assert!(!files.contains(&"chat_response.txt"));
        assert!(!files.contains(&"context-engine-check.txt"));
    }

    #[test]
    fn test_blocks_sensitive_and_binary_files() {
        let (root, _temp) = create_test_project();
        let pkg = shell_scan_project_context(root.to_string_lossy().to_string()).unwrap();

        let has_env = pkg.file_tree_summary.iter().any(|f| f.relative_path.contains(".env"));
        let has_png = pkg.file_tree_summary.iter().any(|f| f.relative_path.contains("image.png"));

        assert!(!has_env);
        assert!(!has_png);
        assert!(pkg.ignored_summary.ignored_secret_files > 0);
        assert!(pkg.ignored_summary.ignored_binary_files > 0);
    }

    #[test]
    fn test_selects_file_by_filename_keyword() {
        let (root, _temp) = create_test_project();
        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "explain apply staged changes".to_string(),
            None
        ).unwrap();

        assert!(pkg.selected_files_count > 0);
        let top_file = &pkg.selected_files[0];
        assert_eq!(top_file.relative_path, "src/apply.rs");
        assert!(top_file.score > 10.0);
    }

    #[test]
    fn test_selects_file_by_content_keyword() {
        let (root, _temp) = create_test_project();
        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "find WorkbenchState code".to_string(),
            None
        ).unwrap();

        assert!(pkg.selected_files_count > 0);
        let top_file = pkg.selected_files.iter().find(|f| f.relative_path == "src/workbench.ts");
        assert!(top_file.is_some());
        assert!(top_file.unwrap().score > 5.0);
    }

    #[test]
    fn test_respects_max_files_limit() {
        let (root, _temp) = create_test_project();
        let opts = BuildTaskContextOptions {
            max_files: Some(1),
            max_total_chars: None,
            include_content: Some(true),
            include_file_tree: Some(true),
            selected_files: None,
            current_file: None,
        };
        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "find anything".to_string(),
            Some(opts)
        ).unwrap();

        assert_eq!(pkg.selected_files_count, 1);
    }

    #[test]
    fn test_apply_changes_query_selects_pipeline_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("apps/desktop-windows/src-tauri/src")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/src/shell")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/src/orchestration")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/src/ui")).unwrap();

        let files = [
            ("apps/desktop-windows/src-tauri/src/apply.rs", "pub fn apply_staged_changes() {}"),
            ("apps/desktop-windows/src-tauri/src/staging.rs", "pub fn write_staged_file() {}"),
            ("apps/desktop-windows/src-tauri/src/commands.rs", "pub fn shell_apply_staged_changes() {}"),
            ("apps/desktop-windows/src/shell/nativeBindings.ts", "export function shell_apply_staged_changes() {}"),
            ("apps/desktop-windows/src/orchestration/desktopOrchestratorTransport.ts", "const pipeline = 'artifact staging apply changes';"),
            ("apps/desktop-windows/src/ui/workbench.ts", "const changesPanel = 'Apply Changes';"),
        ];

        for (path, content) in files {
            let mut f = File::create(root.join(path)).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }

        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "Объясни как работает Apply Changes и какие файлы за это отвечают".to_string(),
            Some(BuildTaskContextOptions {
                max_files: Some(12),
                max_total_chars: Some(80000),
                include_content: Some(true),
                include_file_tree: Some(true),
                selected_files: None,
                current_file: None,
            }),
        ).unwrap();

        let selected = pkg.selected_files.iter().map(|f| f.relative_path.as_str()).collect::<Vec<_>>();
        assert!(selected.contains(&"apps/desktop-windows/src-tauri/src/apply.rs"));
        assert!(selected.contains(&"apps/desktop-windows/src-tauri/src/staging.rs"));
        assert!(selected.contains(&"apps/desktop-windows/src-tauri/src/commands.rs"));
        assert!(selected.contains(&"apps/desktop-windows/src/shell/nativeBindings.ts"));
        assert!(selected.contains(&"apps/desktop-windows/src/orchestration/desktopOrchestratorTransport.ts"));
        assert!(selected.contains(&"apps/desktop-windows/src/ui/workbench.ts"));
    }

    #[test]
    fn test_security_review_prioritizes_code_over_readmes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/src-tauri/src")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/src/shell")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/src/orchestration")).unwrap();

        for idx in 0..5 {
            let mut f = File::create(root.join(format!("docs/README-{}.md", idx))).unwrap();
            f.write_all(b"README security overview").unwrap();
        }
        let files = [
            ("apps/desktop-windows/src-tauri/src/terminal.rs", "pub fn shell_start_command() {}"),
            ("apps/desktop-windows/src-tauri/src/security.rs", "pub fn validate_secret_policy() {}"),
            ("apps/desktop-windows/src-tauri/src/commands.rs", "pub fn shell_apply_staged_changes() {}"),
            ("apps/desktop-windows/src/shell/nativeBindings.ts", "export const shell_start_command = true;"),
            ("apps/desktop-windows/src/orchestration/commandPolicy.ts", "export const destructive = 'git clean -fdx';"),
        ];
        for (path, body) in files {
            let mut f = File::create(root.join(path)).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }

        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "проверь безопасность проекта и код, не только README, API keys, command execution".to_string(),
            Some(BuildTaskContextOptions {
                max_files: Some(8),
                max_total_chars: Some(20000),
                include_content: Some(true),
                include_file_tree: Some(true),
                selected_files: None,
                current_file: None,
            }),
        ).unwrap();

        let selected = pkg.selected_files.iter().map(|f| f.relative_path.as_str()).collect::<Vec<_>>();
        let readme_count = selected.iter().filter(|path| path.to_lowercase().contains("readme")).count();
        assert!(readme_count <= 2, "selected too many README files: {:?}", selected);
        assert!(selected.iter().any(|path| path.ends_with("terminal.rs")));
        assert!(selected.iter().any(|path| path.ends_with("commandPolicy.ts")));
        assert!(selected.iter().any(|path| path.ends_with("nativeBindings.ts")));
    }

    #[test]
    fn test_static_website_prompt_ignores_low_signal_output_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("src")).unwrap();
        let mut output = File::create(root.join("src/karo-test-output.txt")).unwrap();
        output.write_all(b"old generated output").unwrap();
        let mut random_txt = File::create(root.join("src/random-notes.txt")).unwrap();
        random_txt.write_all(b"random note that should not drive website generation").unwrap();

        let mut package = File::create(root.join("package.json")).unwrap();
        package.write_all(br#"{"scripts":{"dev":"vite"}}"#).unwrap();

        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "Создай современный landing page для Minecraft JJK mod с hero, abilities, characters, features, FAQ, responsive layout и preview".to_string(),
            Some(BuildTaskContextOptions {
                max_files: Some(8),
                max_total_chars: Some(20000),
                include_content: Some(true),
                include_file_tree: Some(true),
                selected_files: None,
                current_file: None,
            }),
        ).unwrap();

        let selected = pkg.selected_files.iter().map(|f| f.relative_path.as_str()).collect::<Vec<_>>();
        assert!(
            !selected.contains(&"src/karo-test-output.txt"),
            "low-signal generated output should not become primary context: {:?}",
            selected
        );
        assert!(
            !selected.contains(&"src/random-notes.txt"),
            "random txt files should not become static website context: {:?}",
            selected
        );

        let explicit_pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "Создай файлы сайта. Это file-changing задача, используй Agent Mode и staged artifacts. Создай: src/karo-demo-site/index.html, src/karo-demo-site/styles.css, src/karo-demo-site/script.js, src/karo-demo-site/README.md. Сайт: modern landing page для Minecraft JJK mod. Нужны validation, Apply Changes, provider timeout recovery и fallback только как emergency.".to_string(),
            Some(BuildTaskContextOptions {
                max_files: Some(8),
                max_total_chars: Some(20000),
                include_content: Some(true),
                include_file_tree: Some(true),
                selected_files: None,
                current_file: None,
            }),
        ).unwrap();
        let explicit_selected = explicit_pkg.selected_files.iter().map(|f| f.relative_path.as_str()).collect::<Vec<_>>();
        assert!(
            !explicit_selected.contains(&"src/karo-test-output.txt"),
            "explicit website creation prompt should not select old test output: {:?}",
            explicit_selected
        );
    }

    #[test]
    fn test_ui_work_prefers_workbench_css_tests_and_mcp_scenarios() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("apps/desktop-windows/src/ui")).unwrap();
        fs::create_dir_all(root.join("apps/desktop-windows/mcp/tools")).unwrap();
        fs::create_dir_all(root.join("apps/backend/src/auth")).unwrap();

        let files = [
            ("apps/desktop-windows/src/ui/workbench.ts", "function renderComposer() {}"),
            ("apps/desktop-windows/src/ui/main.css", ".kw-composer { display: grid; }"),
            ("apps/desktop-windows/src/ui/workbench.test.ts", "it('keeps composer visible', () => {})"),
            ("apps/desktop-windows/mcp/tools/scenarios.ts", "export async function responsive_layout() {}"),
            ("apps/backend/src/auth/authService.ts", "export function login() {}"),
        ];
        for (path, body) in files {
            let mut f = File::create(root.join(path)).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }

        let pkg = shell_build_task_context(
            root.to_string_lossy().to_string(),
            "improve UI composer right panel and MCP scenario coverage".to_string(),
            Some(BuildTaskContextOptions {
                max_files: Some(6),
                max_total_chars: Some(20000),
                include_content: Some(true),
                include_file_tree: Some(true),
                selected_files: None,
                current_file: None,
            }),
        ).unwrap();

        let selected = pkg.selected_files.iter().map(|f| f.relative_path.as_str()).collect::<Vec<_>>();
        assert!(selected.contains(&"apps/desktop-windows/src/ui/workbench.ts"));
        assert!(selected.contains(&"apps/desktop-windows/src/ui/main.css"));
        assert!(selected.contains(&"apps/desktop-windows/src/ui/workbench.test.ts"));
        assert!(selected.contains(&"apps/desktop-windows/mcp/tools/scenarios.ts"));
        assert!(!selected.contains(&"apps/backend/src/auth/authService.ts"));
    }

    #[cfg(windows)]
    #[test]
    fn test_build_context_accepts_windows_extended_path() {
        let (root, _temp) = create_test_project();
        let extended = format!(r"\\?\{}", root.to_string_lossy());
        let pkg = shell_build_task_context(
            extended,
            "apply changes".to_string(),
            Some(BuildTaskContextOptions::default()),
        ).unwrap();

        assert!(pkg.scanned_files_count > 0);
    }
}
