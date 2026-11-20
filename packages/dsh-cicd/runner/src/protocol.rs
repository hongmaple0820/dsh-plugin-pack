//! Wire types for Runner Protocol v2 (contract with the dsh-cicd host).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// All endpoints live under `<server>` + this suffix.
pub const PROTOCOL_BASE_SUFFIX: &str = "/api/plugins/cicd/runner/v2";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub runner_id: String,
    pub labels: Vec<String>,
    pub version: String,
    pub capacity: u32,
    pub join_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub ok: bool,
    pub runner_id: String,
    pub runner_token: String,
    pub heartbeat_sec: u64,
    pub offline_after_sec: u64,
    pub server_time: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub runner_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub ok: bool,
    pub last_seen_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    pub runner_id: String,
    pub wait_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct ClaimResponse {
    pub ok: bool,
    pub task: Option<Task>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task_id: String,
    pub run_id: String,
    pub step_index: u32,
    pub stage_id: String,
    pub lease_sec: u64,
    pub workspace: Workspace,
    pub env: HashMap<String, String>,
    pub steps: Vec<Step>,
    pub log_stream: LogStream,
    pub artifacts: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub clean: bool,
    pub ttl_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub uses: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStream {
    #[serde(default)]
    pub batch_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogLine {
    pub seq: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsRequest {
    pub runner_id: String,
    pub task_id: String,
    pub lines: Vec<LogLine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResponse {
    pub ok: bool,
    pub accepted: u64,
    pub dropped: u64,
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Succeeded => "succeeded",
            TaskStatus::Failed => "failed",
            TaskStatus::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRequest {
    pub runner_id: String,
    pub task_id: String,
    pub status: TaskStatus,
    pub exit_code: i64,
    pub error: String,
}

#[derive(Debug, Deserialize)]
pub struct CompleteResponse {
    pub ok: bool,
    #[serde(default)]
    pub code: Option<String>,
}

/// Uniform error body: {"ok":false,"code":"<CODE>","error":"<human readable>"}
#[derive(Debug, Default, Deserialize)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_TASK: &str = r#"{"taskId":"t-abc","runId":"run-9","stepIndex":0,"stageId":"build","leaseSec":600,"workspace":{"root":"tasks/run-9","clean":true,"ttlSec":3600},"env":{"CI":"1"},"steps":[{"uses":"run","command":"echo hi","cwd":".","timeoutSec":60}],"logStream":{"batchMs":250},"artifacts":[]}"#;

    #[test]
    fn register_response_parses() {
        let json = r#"{"ok":true,"runnerId":"r1","runnerToken":"rt_abc","heartbeatSec":30,"offlineAfterSec":90,"serverTime":"2026-11-21T02:00:00.000Z"}"#;
        let r: RegisterResponse = serde_json::from_str(json).unwrap();
        assert!(r.ok);
        assert_eq!(r.runner_id, "r1");
        assert_eq!(r.runner_token, "rt_abc");
        assert_eq!(r.heartbeat_sec, 30);
        assert_eq!(r.offline_after_sec, 90);
        assert_eq!(r.server_time, "2026-11-21T02:00:00.000Z");
    }

    #[test]
    fn register_request_serializes() {
        let req = RegisterRequest {
            runner_id: "r1".into(),
            labels: vec!["linux".into()],
            version: "0.1.0".into(),
            capacity: 2,
            join_token: "jt_x".into(),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["runnerId"], "r1");
        assert_eq!(v["labels"][0], "linux");
        assert_eq!(v["version"], "0.1.0");
        assert_eq!(v["capacity"], 2);
        assert_eq!(v["joinToken"], "jt_x");
    }

    #[test]
    fn claim_response_parses_task_and_null() {
        let null: ClaimResponse = serde_json::from_str(r#"{"ok":true,"task":null}"#).unwrap();
        assert!(null.task.is_none());

        let with: ClaimResponse =
            serde_json::from_str(&format!(r#"{{"ok":true,"task":{SAMPLE_TASK}}}"#)).unwrap();
        let t = with.task.expect("task");
        assert_eq!(t.task_id, "t-abc");
        assert_eq!(t.run_id, "run-9");
        assert_eq!(t.step_index, 0);
        assert_eq!(t.stage_id, "build");
        assert_eq!(t.lease_sec, 600);
        assert_eq!(t.workspace.root, "tasks/run-9");
        assert!(t.workspace.clean);
        assert_eq!(t.workspace.ttl_sec, 3600);
        assert_eq!(t.env.get("CI").map(|s| s.as_str()), Some("1"));
        assert_eq!(t.steps.len(), 1);
        assert_eq!(t.steps[0].uses, "run");
        assert_eq!(t.steps[0].command.as_deref(), Some("echo hi"));
        assert_eq!(t.steps[0].cwd.as_deref(), Some("."));
        assert_eq!(t.steps[0].timeout_sec, Some(60));
        assert_eq!(t.log_stream.batch_ms, Some(250));
        assert!(t.artifacts.is_empty());
    }

    #[test]
    fn logs_response_parses_unknown_task_variant() {
        let r: LogsResponse =
            serde_json::from_str(r#"{"ok":true,"accepted":0,"dropped":2,"code":"TASK_UNKNOWN"}"#).unwrap();
        assert_eq!(r.accepted, 0);
        assert_eq!(r.dropped, 2);
        assert_eq!(r.code.as_deref(), Some("TASK_UNKNOWN"));
    }

    #[test]
    fn logs_request_serializes() {
        let req = LogsRequest {
            runner_id: "r1".into(),
            task_id: "t-abc".into(),
            lines: vec![LogLine { seq: 1, text: "hi".into() }],
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["runnerId"], "r1");
        assert_eq!(v["taskId"], "t-abc");
        assert_eq!(v["lines"][0]["seq"], 1);
        assert_eq!(v["lines"][0]["text"], "hi");
    }

    #[test]
    fn complete_request_serializes() {
        let req = CompleteRequest {
            runner_id: "r1".into(),
            task_id: "t-abc".into(),
            status: TaskStatus::Succeeded,
            exit_code: 0,
            error: String::new(),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["runnerId"], "r1");
        assert_eq!(v["taskId"], "t-abc");
        assert_eq!(v["status"], "succeeded");
        assert_eq!(v["exitCode"], 0);
        assert_eq!(v["error"], "");

        let req = CompleteRequest {
            runner_id: "r1".into(),
            task_id: "t-abc".into(),
            status: TaskStatus::Canceled,
            exit_code: -1,
            error: "boom".into(),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["status"], "canceled");
        assert_eq!(v["exitCode"], -1);
        assert_eq!(v["error"], "boom");
    }

    #[test]
    fn api_error_body_parses() {
        let e: ApiErrorBody =
            serde_json::from_str(r#"{"ok":false,"code":"RUNNER_REVOKED","error":"revoked"}"#).unwrap();
        assert!(!e.ok);
        assert_eq!(e.code.as_deref(), Some("RUNNER_REVOKED"));
        assert_eq!(e.error.as_deref(), Some("revoked"));
    }

    #[test]
    fn heartbeat_response_parses() {
        let r: HeartbeatResponse =
            serde_json::from_str(r#"{"ok":true,"lastSeenAt":"2026-11-21T02:00:00.000Z"}"#).unwrap();
        assert!(r.ok);
        assert_eq!(r.last_seen_at, "2026-11-21T02:00:00.000Z");
    }
}
