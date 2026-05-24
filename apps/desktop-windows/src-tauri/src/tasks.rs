use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStateSnapshot {
    pub id: String,
    pub status: String,
    pub current_agent_id: Option<String>,
    pub review_cycles: u32,
    pub max_review_cycles: u32,
    pub created_at: String,
    pub updated_at: String,
    pub original_prompt: String,
    pub model_id: String,
    pub provider: String,
    pub participants: Vec<String>,
    #[serde(default)]
    pub error_reason: Option<String>,
    #[serde(default)]
    pub consent_request: Option<ConsentRequest>,
    #[serde(default)]
    pub staging_directory: Option<String>,
    #[serde(default)]
    pub test_run_log_path: Option<String>,
    #[serde(default)]
    pub test_run_log_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecord {
    pub kind: String, // "thought", "tool_call", "artifact_change", "status"
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub input: Option<serde_json::Value>,
    #[serde(default)]
    pub output: Option<serde_json::Value>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    pub task_id: String,
    pub agent_id: String,
    pub sequence: u32,
    pub at: String,
    pub record: TraceRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMetadata {
    pub id: String,
    pub task_id: String,
    pub file_name: String,
    pub latest_version: u32,
    pub latest_content_hash: String,
    pub authored_by_agent_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub artifact_id: String,
    pub version: u32,
    pub file_name: String,
    pub content_hash: String,
    pub content: String,
    pub authored_by_agent_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BossVerdictSummary {
    pub kind: String, // "approved" | "rejected"
    pub verdict: String, // "соответствует" | "не соответствует"
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalArtifactSummary {
    pub artifact_id: String,
    pub version: u32,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalReportSummary {
    pub task_id: String,
    pub status: String,
    pub original_prompt: String,
    pub participants: Vec<String>,
    pub review_cycles_performed: u32,
    #[serde(default)]
    pub boss_summary: Option<String>,
    #[serde(default)]
    pub outstanding_issues: Option<Vec<String>>,
    pub final_artifacts: Vec<FinalArtifactSummary>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub success: bool,
    pub changed_files: Vec<String>,
    pub created_files: Vec<String>,
    pub overwritten_files: Vec<String>,
    pub skipped_files: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInternalPersistent {
    pub state: TaskStateSnapshot,
    pub trace: Vec<TraceEvent>,
    pub next_sequence: u32,
    pub artifacts: Vec<ArtifactVersion>,
    pub artifact_meta: Vec<ArtifactMetadata>,
    #[serde(default)]
    pub final_report: Option<FinalReportSummary>,
    #[serde(default)]
    pub apply_result: Option<ApplyResult>,
}
