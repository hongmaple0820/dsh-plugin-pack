//! Wire types for Runner Protocol v2 (contract with the dsh-cicd host).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// All endpoints live under `<server>` + this suffix.
pub const PROTOCOL_BASE_SUFFIX: &str = "/api/plugins/cicd/runner/v2";

/// 本 runner 讲的协议版本。M5 起注册时主动上报，宿主据此拒绝/放行。
pub const RUNNER_PROTOCOL: u32 = 2;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub runner_id: String,
    pub labels: Vec<String>,
    pub version: String,
    pub capacity: u32,
    pub join_token: String,
    /// M2 能力上报：本机可用工具（如 "git"）。为空时不序列化，兼容 M1 宿主。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    /// M5 协议握手：自报版本。None 时字段整个省略，老宿主照旧按 v1 收。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<u32>,
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
    /// 宿主认下的协议版本（M5 之前的宿主不回这两个字段）。
    #[serde(default)]
    pub protocol: Option<u32>,
    /// 宿主能接受的最低版本：比本 runner 高就必须停下来，别用旧规矩解释新任务。
    #[serde(default)]
    pub min_protocol: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub runner_id: String,
    /// M3：负载上报（在跑任务数 / 磁盘余量 / 缓存命中统计）。旧宿主不读，缺失也不报错。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<RunnerStats>,
}

/// 心跳负载。字段全部可选：任何一种不知道就省略，而不是编一个 0 出来。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<u32>,
    /// 磁盘剩余百分比（0-100）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_free_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheStats>,
}

/// 缓存计数器：runner 生命周期内累计。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub saves: u64,
}

/// POST /credentials：用名字换短期值（值只进子进程 env，不落盘不进日志）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsRequest {
    pub runner_id: String,
    pub task_id: String,
    pub names: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub values: HashMap<String, String>,
    /// 值的过期时刻；runner 据此在下一步之前重换。
    #[serde(default)]
    pub expires_at: String,
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
    /// M4：制品回流声明（该 stage 的 uses: collect）。runner 在步骤全部成功后按 paths
    /// 在 workspace 里 glob，逐名 PUT 回宿主 CAS，再在 complete 里报清单。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactDecl>,
    /// M2 checkout 源：存在时先在工作目录 checkout 再跑 run 步骤。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    /// M3：任务所属项目。缓存命名空间与凭据授权都以它为准（缺省按空串处理）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
    /// M3：只带名字的密钥清单——值另走 POST /credentials，任务体里永远没有明文。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_refs: Vec<String>,
    /// M3：env 里「哪个键由哪个 ref 填充」——值的来源仍是 /credentials，任务体只有映射。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_env: Vec<SecretEnvRef>,
    /// M3：本任务的缓存声明（key 命中即恢复，任务成功后保存）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cache: Vec<CacheDecl>,
}

/// 一个回流制品的声明：名字（同时是 CAS 指针名）加上相对 workspace 根的 glob。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDecl {
    pub name: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// 缺省 false：声明了就必须回流的才算缺失（optional 只用于「有就发」的产物）。
    #[serde(default)]
    pub optional: bool,
}

/// env 键 → 凭据名。与 secretRefs 一起下发，runner 拿到值后按这张表落进子进程 env。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnvRef {
    /// 子进程里要设置的 env 键名。
    pub env: String,
    /// 对应的凭据名（/credentials 的 names 之一）。
    #[serde(rename = "ref")]
    pub reference: String,
}

/// 一条缓存声明，与宿主 `uses: cache` 的入参同名同义。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDecl {
    pub key: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub restore_keys: Vec<String>,
    /// restore / save / both；缺省 both。
    #[serde(default = "default_cache_mode")]
    pub mode: String,
}

fn default_cache_mode() -> String {
    "both".to_string()
}

/// POST /cache/lookup：问宿主「这个 key（或这些 restoreKeys）有没有缓存」。
/// 只回指针和大小，字节走 GET /cache/blob 单独取。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLookupRequest {
    pub runner_id: String,
    pub task_id: String,
    pub key: String,
    #[serde(default)]
    pub restore_keys: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLookupResponse {
    #[serde(default)]
    pub ok: bool,
    /// false = 未命中（不是错误，正常继续构建）。
    #[serde(default)]
    pub hit: bool,
    /// 命中的 key（可能是 restoreKeys 前缀匹配到的旧 key）。
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub paths: Vec<String>,
}

/// PUT /cache/blob 的回执：digest 是内容地址，deduped 表示字节已在 CAS 里。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSaveResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub deduped: bool,
}

/// claim 下发的源码描述。目前只支持 type=git。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    #[serde(rename = "type")]
    pub source_type: String,
    pub url: String,
    /// 分支或 tag（"ref" 是 Rust 关键字，字段名用 git_ref）。
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub depth: Option<u64>,
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
    /// M4：本任务回流的制品清单。宿主按「声明必须到齐」校验，缺非 optional 的直接判失败。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactReport>,
}

/// complete 里的一项制品：名字必须与任务声明一致（宿主用它校验，digest 由宿主 CAS 复核）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReport {
    pub name: String,
    pub digest: String,
    pub bytes: u64,
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
            tools: vec!["git".into()],
            protocol: Some(RUNNER_PROTOCOL),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["runnerId"], "r1");
        assert_eq!(v["protocol"], RUNNER_PROTOCOL);
        assert_eq!(v["labels"][0], "linux");
        assert_eq!(v["version"], "0.1.0");
        assert_eq!(v["capacity"], 2);
        assert_eq!(v["joinToken"], "jt_x");
        assert_eq!(v["tools"][0], "git");

        // 空 tools 不序列化：M1 宿主看到的请求体完全不变。
        let req = RegisterRequest {
            runner_id: "r1".into(),
            labels: vec![],
            version: "0.1.0".into(),
            capacity: 2,
            join_token: "jt_x".into(),
            tools: vec![],
            protocol: None,
        };
        let v = serde_json::to_value(&req).unwrap();
        assert!(v.get("tools").is_none(), "{v}");
        assert!(v.get("protocol").is_none(), "自报版本是可选的：{v}");
    }

    #[test]
    fn task_source_parses_and_stays_optional() {
        // 无 source：与 M1 完全一致。
        let t: Task = serde_json::from_str(SAMPLE_TASK).unwrap();
        assert!(t.source.is_none());

        // 带 source + checkout 步骤。
        let with = SAMPLE_TASK.replace(
            "\"artifacts\":[]",
            "\"artifacts\":[],\"source\":{\"type\":\"git\",\"url\":\"file:///repo\",\"ref\":\"main\",\"sha\":\"abc123\",\"depth\":1}",
        ).replace(
            "\"steps\":[{\"uses\":\"run\"",
            "\"steps\":[{\"uses\":\"checkout\"},{\"uses\":\"run\"",
        );
        let t: Task = serde_json::from_str(&with).unwrap();
        let src = t.source.expect("source");
        assert_eq!(src.source_type, "git");
        assert_eq!(src.url, "file:///repo");
        assert_eq!(src.git_ref.as_deref(), Some("main"));
        assert_eq!(src.sha.as_deref(), Some("abc123"));
        assert_eq!(src.depth, Some(1));
        assert_eq!(t.steps[0].uses, "checkout");
        assert_eq!(t.steps[1].uses, "run");

        // source 各字段可缺省（只有 url 是必填）。
        let t: Task = serde_json::from_str(&SAMPLE_TASK.replace(
            "\"artifacts\":[]",
            "\"artifacts\":[],\"source\":{\"type\":\"git\",\"url\":\"file:///r\"}",
        )).unwrap();
        let src = t.source.unwrap();
        assert_eq!(src.git_ref, None);
        assert_eq!(src.sha, None);
        assert_eq!(src.depth, None);
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
        // M4：带声明的任务要能解析出 name/paths/optional（宿主 JSON 形状是契约）。
        let with_artifacts: Task = serde_json::from_str(
            r#"{"taskId":"t-1","runId":"run-1","stepIndex":0,"stageId":"build","leaseSec":60,"workspace":{"root":"ws/run-1","clean":true,"ttlSec":600},"env":{},"steps":[],"logStream":{"batchMs":250},"artifacts":[{"name":"web-dist","paths":["dist/**"],"optional":false},{"name":"meta","paths":["meta.json"]}]}"#,
        )
        .unwrap();
        assert_eq!(with_artifacts.artifacts.len(), 2);
        assert_eq!(with_artifacts.artifacts[0].name, "web-dist");
        assert_eq!(with_artifacts.artifacts[1].paths, vec!["meta.json".to_string()]);
        assert!(!with_artifacts.artifacts[1].optional);
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
            artifacts: vec![ArtifactReport { name: "web-dist".into(), digest: "sha256:abc".into(), bytes: 12 }],
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["runnerId"], "r1");
        assert_eq!(v["taskId"], "t-abc");
        assert_eq!(v["status"], "succeeded");
        assert_eq!(v["exitCode"], 0);
        assert_eq!(v["error"], "");
        assert_eq!(v["artifacts"][0]["name"], "web-dist");
        assert_eq!(v["artifacts"][0]["digest"], "sha256:abc");

        let req = CompleteRequest {
            runner_id: "r1".into(),
            task_id: "t-abc".into(),
            status: TaskStatus::Canceled,
            exit_code: -1,
            error: "boom".into(),
            artifacts: Vec::new(),
        };
        let v = serde_json::to_value(&req).unwrap();
        // 空清单不出现在报文里：M3 的任务体形状对老观察者完全不变。
        assert!(v.get("artifacts").is_none());
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
