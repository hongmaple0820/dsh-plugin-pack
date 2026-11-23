//! End-to-end integration tests against a hand-written HTTP/1.1 mock server.
//!
//! The mock implements the five Runner Protocol v2 endpoints statefully
//! (register / heartbeat / claim / logs / complete) so the real runner binary
//! can be exercised: register -> claim -> exec -> logs(seq) -> complete.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const JOIN_TOKEN: &str = "jt_test";
const RUNNER_TOKEN: &str = "rt_good";

fn work_root(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-tmp")
        .join("it")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create work root");
    dir
}

#[derive(Default, Clone)]
struct State {
    registered: bool,
    token: String,
    heartbeats: u32,
    claims: u32,
    /// Lines accepted per task with a count of duplicate (taskId, seq) pairs.
    accepted: HashMap<String, usize>,
    seen_seqs: HashMap<String, Vec<u64>>,
    duplicate_seqs: HashMap<String, usize>,
    completed: Vec<(String, String, i64, String)>,
    last_log_text: Vec<String>,
    log_posts: u32,
    /// M2: register 请求体里上报的 tools 数组。
    register_tools: Vec<String>,
    /// 注册请求里自报的协议版本（M5 握手），用来证明 runner 真的报了。
    register_protocol: Option<u64>,
    /// M3: /credentials 被调用了几次，以及最后一次的请求细节。
    cred_calls: u32,
    cred_runner_id: String,
    cred_task_id: String,
    cred_names: Vec<String>,
    cred_bearer: String,
    /// M3: 收到的每一个 complete 请求体原文（断言明文不出现）。
    complete_bodies: Vec<String>,
    /// M3 缓存：lookup 调用次数与请求体、GET blob 次数、PUT blob 的 (key, body 字节数)。
    cache_lookups: u32,
    cache_lookup_bodies: Vec<String>,
    cache_gets: u32,
    cache_puts: Vec<(String, usize)>,
    /// 每次 heartbeat 请求体里 stats 字段的原文（缺失时为 null）。
    heartbeat_stats: Vec<serde_json::Value>,
    /// M4 制品：PUT /artifacts/:taskId/:name 的 (name, body 字节)。
    artifact_puts: Vec<(String, Vec<u8>)>,
}

struct Mock {
    addr: String,
    state: Arc<Mutex<State>>,
}

impl Mock {
    fn server(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

/// Register behaviour: "ok" mints a token, "reject" answers 401.
#[derive(Clone)]
enum RegisterMode {
    Ok,
    Reject,
    /// 宿主已升到更高协议：注册成功但 minProtocol 高于本 runner 支持版本。
    MinProtocolTooNew(u64),
}

/// Heartbeat behaviour: "ok" answers 200, "401" answers RUNNER_TOKEN_INVALID.
#[derive(Clone)]
enum HeartbeatMode {
    Ok,
    Unauthorized,
}

/// /credentials 行为：Ok 发一组值，Deny 回 api 错误（fail closed 用例）。
#[derive(Clone)]
enum CredMode {
    Ok {
        values: HashMap<String, String>,
        expires_at: String,
    },
    Deny {
        status: u16,
        code: String,
    },
}

/// /cache/lookup 行为：Hit 命中并给出可下载的 blob 字节，Miss 未命中，Error 回状态码。
#[derive(Clone)]
enum CacheMode {
    Hit { digest: String, blob: Vec<u8> },
    Miss,
    Error(u16),
}

fn start_mock(register: RegisterMode, heartbeat: HeartbeatMode, task: Option<String>) -> Mock {
    spawn_mock(register, heartbeat, task, None, None, 30)
}

fn start_mock_with_creds(
    register: RegisterMode,
    heartbeat: HeartbeatMode,
    task: Option<String>,
    creds: Option<CredMode>,
) -> Mock {
    spawn_mock(register, heartbeat, task, creds, None, 30)
}

fn start_mock_with_cache(
    register: RegisterMode,
    heartbeat: HeartbeatMode,
    task: Option<String>,
    cache: CacheMode,
) -> Mock {
    // 存取用例要断言心跳负载，周期压到 1s，免得等满 30s。
    spawn_mock(register, heartbeat, task, None, Some(cache), 1)
}

/// 注册响应里把 heartbeatSec 调小（后台心跳周期的来源）。
fn start_mock_with_hb(
    register: RegisterMode,
    heartbeat: HeartbeatMode,
    task: Option<String>,
    heartbeat_sec: u64,
) -> Mock {
    spawn_mock(register, heartbeat, task, None, None, heartbeat_sec)
}

fn spawn_mock(
    register: RegisterMode,
    heartbeat: HeartbeatMode,
    task: Option<String>,
    creds: Option<CredMode>,
    cache: Option<CacheMode>,
    heartbeat_sec: u64,
) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock listener");
    let addr = listener.local_addr().unwrap().to_string();
    let state = Arc::new(Mutex::new(State::default()));
    let st = state.clone();
    thread::spawn(move || {
        for conn in listener.incoming() {
            let mut stream = match conn {
                Ok(s) => s,
                Err(_) => break,
            };
            let st = st.clone();
            let register = register.clone();
            let heartbeat = heartbeat.clone();
            let task = task.clone();
            let creds = creds.clone();
            let cache = cache.clone();
            thread::spawn(move || {
                // One request per connection: read headers, then the body.
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let (mut head_end, mut length) = (None, 0usize);
                loop {
                    let n = match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    raw.extend_from_slice(&buf[..n]);
                    if head_end.is_none() {
                        if let Some(pos) = find(&raw, b"\r\n\r\n") {
                            head_end = Some(pos + 4);
                            let head = String::from_utf8_lossy(&raw[..pos]).to_string();
                            for line in head.lines() {
                                let lower = line.to_ascii_lowercase();
                                if let Some(v) = lower.strip_prefix("content-length:") {
                                    length = v.trim().parse().unwrap_or(0);
                                }
                            }
                        }
                    }
                    if let Some(h) = head_end {
                        if raw.len() >= h + length {
                            break;
                        }
                    }
                }
                let head_end = head_end.unwrap_or(0);
                let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                let body = String::from_utf8_lossy(&raw[head_end.min(raw.len())..]).to_string();
                let path = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let bearer = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .map(|l| {
                        l[l.find(':').map(|i| i + 1).unwrap_or(0)..]
                            .trim()
                            .trim_start_matches("Bearer ")
                            .trim_start_matches("bearer ")
                            .trim()
                            .to_string()
                    })
                    .unwrap_or_default();
                let method = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().next())
                    .unwrap_or("")
                    .to_string();
                let (raw_path, query) = match path.split_once('?') {
                    Some((p, q)) => (p.to_string(), q.to_string()),
                    None => (path.clone(), String::new()),
                };
                let endpoint = raw_path.rsplit('/').next().unwrap_or("").to_string();
                let json: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                let mut s = st.lock().unwrap();
                // GET /cache/blob 回裸字节（其余端点回 JSON）。
                if endpoint == "blob" && method == "GET" {
                    s.cache_gets += 1;
                    let digest = query_param(&query, "digest");
                    let hit = match &cache {
                        Some(CacheMode::Hit { digest: d, blob }) if *d == digest => Some(blob.clone()),
                        _ => None,
                    };
                    let resp = match hit {
                        Some(blob) => {
                            let mut resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                blob.len()
                            )
                            .into_bytes();
                            resp.extend_from_slice(&blob);
                            resp
                        }
                        None => {
                            let body = serde_json::json!({"ok": false,
                                "code": "CACHE_NOT_DECLARED", "error": "cache blob unavailable"})
                            .to_string();
                            format!(
                                "HTTP/1.1 403 Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            )
                            .into_bytes()
                        }
                    };
                    let _ = stream.write_all(&resp);
                    let _ = stream.flush();
                    return;
                }
                // PUT /artifacts/:taskId/:name：记下名字与裸字节，回 JSON 回执。
                if method == "PUT" && raw_path.contains("/artifacts/") {
                    let name = endpoint.clone();
                    let body = raw[head_end.min(raw.len())..].to_vec();
                    let bytes = body.len();
                    s.artifact_puts.push((name.clone(), body));
                    let payload = serde_json::json!({"ok": true, "name": name,
                        "digest": format!("sha256:art-{name}"), "bytes": bytes, "deduped": false})
                    .to_string();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        payload.len(),
                        payload
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                    return;
                }
                let (status, payload) = match endpoint.as_str() {
                    "register" => match register {
                        RegisterMode::Reject => (
                            401,
                            serde_json::json!({"ok": false, "code": "RUNNER_JOIN_TOKEN_INVALID",
                                "error": "join token invalid"}),
                        ),
                        RegisterMode::MinProtocolTooNew(min) => {
                            s.registered = true;
                            (
                                200,
                                serde_json::json!({"ok": true, "runnerId": "r-1",
                                    "runnerToken": RUNNER_TOKEN, "heartbeatSec": heartbeat_sec,
                                    "offlineAfterSec": 90,
                                    "serverTime": "2026-11-21T02:00:00.000Z",
                                    "protocol": min, "minProtocol": min}),
                            )
                        }
                        RegisterMode::Ok => {
                            let join = json.get("joinToken").and_then(|v| v.as_str()).unwrap_or("");
                            if join != JOIN_TOKEN {
                                (
                                    401,
                                    serde_json::json!({"ok": false, "code": "RUNNER_JOIN_TOKEN_INVALID",
                                        "error": "join token invalid"}),
                                )
                            } else {
                                s.registered = true;
                                s.token = RUNNER_TOKEN.to_string();
                                s.register_protocol = json.get("protocol").and_then(|v| v.as_u64());
                                s.register_tools = json
                                    .get("tools")
                                    .and_then(|v| v.as_array())
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                // Serve one task per registration (--once runs).
                                s.claims = 0;
                                let id = json
                                    .get("runnerId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                (
                                    200,
                                    serde_json::json!({"ok": true, "runnerId": id,
                                        "runnerToken": RUNNER_TOKEN, "heartbeatSec": heartbeat_sec,
                                        "offlineAfterSec": 90,
                                        "serverTime": "2026-11-21T02:00:00.000Z"}),
                                )
                            }
                        }
                    },
                    "heartbeat" => match heartbeat {
                        HeartbeatMode::Unauthorized => {
                            s.heartbeats += 1;
                            (
                                401,
                                serde_json::json!({"ok": false, "code": "RUNNER_TOKEN_INVALID",
                                    "error": "token invalid"}),
                            )
                        }
                        HeartbeatMode::Ok => {
                            if bearer != RUNNER_TOKEN || !s.registered {
                                (
                                    401,
                                    serde_json::json!({"ok": false, "code": "RUNNER_TOKEN_INVALID",
                                        "error": "token invalid"}),
                                )
                            } else {
                                s.heartbeats += 1;
                                s.heartbeat_stats
                                    .push(json.get("stats").cloned().unwrap_or(serde_json::Value::Null));
                                (
                                    200,
                                    serde_json::json!({"ok": true,
                                        "lastSeenAt": "2026-11-21T02:00:01.000Z"}),
                                )
                            }
                        }
                    },
                    "claim" => {
                        // A fresh register mints a new token, so compare against
                        // RUNNER_TOKEN directly rather than the register-time copy.
                        if bearer != RUNNER_TOKEN {
                            (
                                401,
                                serde_json::json!({"ok": false, "code": "RUNNER_TOKEN_INVALID",
                                    "error": "token invalid"}),
                            )
                        } else {
                            s.claims += 1;
                            if s.claims == 1 {
                                match &task {
                                    Some(t) => {
                                        let v: serde_json::Value =
                                            serde_json::from_str(t).unwrap();
                                        (200, serde_json::json!({"ok": true, "task": v}))
                                    }
                                    None => (200, serde_json::json!({"ok": true, "task": null})),
                                }
                            } else {
                                (200, serde_json::json!({"ok": true, "task": null}))
                            }
                        }
                    }
                    "logs" => {
                        s.log_posts += 1;
                        let task_id = json
                            .get("taskId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // Unknown tasks are acknowledged idempotently: every
                        // line is reported as dropped and nothing is stored.
                        let known = task
                            .as_deref()
                            .map(|t| t.contains(&task_id))
                            .unwrap_or(false);
                        let mut accepted = 0usize;
                        let mut dropped = 0usize;
                        if !known {
                            let n = json
                                .get("lines")
                                .and_then(|v| v.as_array())
                                .map(|l| l.len())
                                .unwrap_or(0);
                            dropped = n;
                        } else if let Some(lines) = json.get("lines").and_then(|v| v.as_array()) {
                            let mut seen = s.seen_seqs.remove(&task_id).unwrap_or_default();
                            for line in lines {
                                let seq = line.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                                let text = line
                                    .get("text")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if seen.contains(&seq) {
                                    dropped += 1;
                                    *s.duplicate_seqs.entry(task_id.clone()).or_default() += 1;
                                } else {
                                    seen.push(seq);
                                    accepted += 1;
                                    *s.accepted.entry(task_id.clone()).or_default() += 1;
                                    s.last_log_text.push(text);
                                }
                            }
                            s.seen_seqs.insert(task_id.clone(), seen);
                        }
                        let mut payload = serde_json::json!({"ok": true,
                            "accepted": accepted, "dropped": dropped});
                        if !known {
                            payload["code"] = serde_json::json!("TASK_UNKNOWN");
                        }
                        (200, payload)
                    }
                    "complete" => {
                        s.complete_bodies.push(body.clone());
                        let task_id = json
                            .get("taskId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let known = task
                            .as_deref()
                            .map(|t| t.contains(&task_id))
                            .unwrap_or(false);
                        if !known {
                            (
                                200,
                                serde_json::json!({"ok": true, "code": "TASK_UNKNOWN"}),
                            )
                        } else {
                            s.completed.push((
                                task_id,
                                json.get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                json.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0),
                                json.get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            ));
                            (200, serde_json::json!({"ok": true}))
                        }
                    }
                    "credentials" => match &creds {
                        None => (404, serde_json::json!({"ok": false, "code": "NOT_FOUND"})),
                        Some(CredMode::Deny { status, code }) => {
                            s.cred_calls += 1;
                            (
                                *status,
                                serde_json::json!({"ok": false, "code": code,
                                    "error": "credentials denied"}),
                            )
                        }
                        Some(CredMode::Ok { values, expires_at }) => {
                            s.cred_calls += 1;
                            s.cred_runner_id = json
                                .get("runnerId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            s.cred_task_id = json
                                .get("taskId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            s.cred_names = json
                                .get("names")
                                .and_then(|v| v.as_array())
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                        .collect()
                                })
                                .unwrap_or_default();
                            s.cred_bearer = bearer.clone();
                            (
                                200,
                                serde_json::json!({"ok": true,
                                    "values": values.clone(),
                                    "expiresAt": expires_at}),
                            )
                        }
                    },
                    "lookup" => {
                        s.cache_lookups += 1;
                        s.cache_lookup_bodies.push(body.clone());
                        let key = json.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        match &cache {
                            None => (404, serde_json::json!({"ok": false,
                                "code": "TASK_UNKNOWN", "error": "no cache declaration"})),
                            Some(CacheMode::Error(status)) => (*status, serde_json::json!({"ok": false,
                                "code": "CACHE_UNAVAILABLE", "error": "cache down"})),
                            Some(CacheMode::Miss) => (200, serde_json::json!({"ok": true,
                                "hit": false, "key": key, "digest": "", "bytes": 0, "paths": []})),
                            Some(CacheMode::Hit { digest, blob }) => (200, serde_json::json!({"ok": true,
                                "hit": true, "key": key, "digest": digest, "bytes": blob.len(),
                                "paths": ["dist"]})),
                        }
                    }
                    "blob" => {
                        // PUT：body 是裸 tar.gz，按字节数记账。
                        let key = query_param(&query, "key");
                        let bytes = raw.len().saturating_sub(head_end.min(raw.len()));
                        s.cache_puts.push((key.clone(), bytes));
                        (200, serde_json::json!({"ok": true, "key": key,
                            "digest": "sha256:mock", "bytes": bytes, "deduped": false}))
                    }
                    _ => (404, serde_json::json!({"ok": false, "code": "NOT_FOUND"})),
                };
                let body = payload.to_string();
                let resp = format!(
                    "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    if status == 200 { "OK" } else { "Error" },
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            });
        }
    });
    Mock { addr, state }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 解析 query 里一个参数（reqwest 会把 ":" 编码成 %3A）。
fn query_param(query: &str, name: &str) -> String {
    query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| percent_decode(v))
        .unwrap_or_default()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn tar_ok() -> bool {
    Command::new("tar")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 起一个常驻 runner（不带 --once）：跑完任务后会空闲并心跳，供断言心跳负载。
fn spawn_runner(server: &str, workdir: &PathBuf) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_dsh-cicd-runner"))
        .args([
            "--server",
            server,
            "--runner",
            "r1",
            "--join-token",
            JOIN_TOKEN,
            "--workdir",
            workdir.to_str().unwrap(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn runner")
}

fn echo_task() -> String {
    serde_json::json!({
        "taskId": "t-abc",
        "runId": "run-9",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "tasks/run-9", "clean": true, "ttlSec": 3600},
        "env": {"CI": "1"},
        "steps": [{"uses": "run", "command": "echo hi", "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string()
}

fn run_once(server: &str, workdir: &PathBuf, join_token: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_dsh-cicd-runner"))
        .args([
            "--server",
            server,
            "--runner",
            "r1",
            "--join-token",
            join_token,
            "--labels",
            "linux,fast",
            "--capacity",
            "2",
            "--workdir",
            workdir.to_str().unwrap(),
            "--once",
        ])
        .stdin(Stdio::null())
        .output()
        .expect("spawn runner binary")
}

fn wait_until<F: Fn(&State) -> bool>(mock: &Mock, f: F, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if f(&mock.state()) {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Full lifecycle: register -> claim -> exec -> logs(seq) -> complete succeeded.
#[test]
fn full_lifecycle_register_claim_exec_logs_complete() {
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(echo_task()));
    let dir = work_root("lifecycle");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    { let st = mock.state(); std::fs::write(format!("{}/x.txt", dir.display()), format!("{:?}\n{:?}", st.completed, st.last_log_text)).ok(); }

    assert!(
        out.status.success(),
        "runner must exit 0 after a succeeded task; exit={:?} stderr=\n{stderr}",
        out.status.code()
    );

    let s = mock.state();
    assert!(s.registered, "register must have been called");
    assert_eq!(s.claims, 1, "one claim in --once mode");
    assert_eq!(s.log_posts >= 1, true, "logs must be posted: {stderr}");
    let accepted = *s.accepted.get("t-abc").unwrap_or(&0);
    assert!(accepted >= 1, "at least one log line accepted: {stderr}");
    let mut seqs = s.seen_seqs.get("t-abc").cloned().unwrap_or_default();
    seqs.sort_unstable();
    seqs.dedup();
    assert_eq!(seqs.first(), Some(&1u64), "seq starts at 1");
    for w in seqs.windows(2) {
        assert!(w[1] > w[0], "seq must be strictly increasing: {seqs:?}");
    }
    assert!(
        s.last_log_text.iter().any(|t| t.contains("hi")),
        "echo output must reach the server: {:?}",
        s.last_log_text
    );
    assert_eq!(s.completed.len(), 1, "exactly one complete");
    let (task_id, status, exit_code, error) = &s.completed[0];
    assert_eq!(task_id, "t-abc");
    assert_eq!(status, "succeeded");
    assert_eq!(*exit_code, 0);
    assert_eq!(error, "");

    // Journal: claimed + finished both present, credentials written.
    let journal = std::fs::read_to_string(dir.join("journal.log")).expect("journal.log");
    assert!(journal.contains("\"event\":\"claimed\""), "{journal}");
    assert!(journal.contains("\"event\":\"finished\""), "{journal}");
    let creds = std::fs::read_to_string(dir.join("credentials.json")).expect("credentials.json");
    assert!(creds.contains(RUNNER_TOKEN), "{creds}");
}

/// A wrong join token is fatal: the runner exits non-zero without claiming.
#[test]
fn bad_join_token_exits_with_error() {
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(echo_task()));
    let dir = work_root("bad-join");
    let out = run_once(&mock.server(), &dir, "jt_wrong");
    assert!(
        !out.status.success(),
        "401 on register must abort the runner"
    );
    assert_eq!(mock.state().claims, 0, "never claims with a bad token");
}

/// M5 握手：runner 注册时自报协议版本，宿主据此放行/拒绝。
#[test]
fn register_declares_protocol_version() {
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(echo_task()));
    let dir = work_root("reg-protocol");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    assert!(out.status.success(), "普通的 v2 握手必须成功");
    assert_eq!(
        mock.state().register_protocol,
        Some(2),
        "runner 必须自报 protocol=2，宿主才有依据拒绝错版本的机器"
    );
}

/// 宿主已经升到更高协议时，runner 立刻停下——用旧规矩解释新任务只会更难查。
#[test]
fn newer_host_protocol_stops_the_runner() {
    let mock = start_mock(RegisterMode::MinProtocolTooNew(3), HeartbeatMode::Ok, Some(echo_task()));
    let dir = work_root("reg-protocol-newer");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    assert!(!out.status.success(), "minProtocol 高于本机时不能继续跑");
    assert_eq!(mock.state().claims, 0, "握手失败就不能领任务");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("协议") || stderr.contains("protocol"),
        "错误里要说清是协议版本问题：{stderr}"
    );
}

/// A 401 on register is fatal even when the server rejects every join token.
#[test]
fn register_rejected_exits_nonzero() {
    let mock = start_mock(RegisterMode::Reject, HeartbeatMode::Ok, None);
    let dir = work_root("reg-reject");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    assert!(!out.status.success());
    assert_eq!(mock.state().claims, 0);
}

/// heartbeat 401 is reported and the runner keeps its idle loop alive; with
/// --once it never exits by itself, so the test asserts on the log line only.
#[test]
fn heartbeat_unauthorized_is_reported() {
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Unauthorized, None);
    let dir = work_root("hb-401");
    let mut child = Command::new(env!("CARGO_BIN_EXE_dsh-cicd-runner"))
        .args([
            "--server",
            &mock.server(),
            "--runner",
            "r1",
            "--join-token",
            JOIN_TOKEN,
            "--workdir",
            dir.to_str().unwrap(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn runner");
    let seen = wait_until(&mock, |s| s.heartbeats >= 1, Duration::from_secs(10));
    assert!(seen, "runner must call heartbeat when no task is available");
    let _ = child.kill();
    let _ = child.wait();
}

/// The mock deduplicates by (taskId, seq): replaying the same seq is dropped.
#[test]
fn duplicate_seq_is_deduped_by_server() {
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(echo_task()));
    let dir = work_root("dedupe");
    // Two concurrent runners would be overkill; drive the endpoint directly.
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let body = serde_json::json!({
        "runnerId": "r1",
        "taskId": "t-abc",
        "lines": [{"seq": 1, "text": "echo hi"}, {"seq": 999, "text": "new line"}]
    })
    .to_string();
    let resp = post_logs(&mock.server(), &body);
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["accepted"], 1, "only the unseen seq is accepted: {resp}");
    assert_eq!(v["dropped"], 1, "the replayed seq is dropped: {resp}");

    let unknown = serde_json::json!({
        "runnerId": "r1",
        "taskId": "t-missing",
        "lines": [{"seq": 1, "text": "x"}, {"seq": 2, "text": "y"}]
    })
    .to_string();
    let resp = post_logs(&mock.server(), &unknown);
    let v: serde_json::Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["ok"], true, "unknown task stays 200/idempotent: {resp}");
    assert_eq!(v["dropped"], 2);
}

fn git_ok() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 建一个最小本地 git 仓库，返回默认分支名（供 checkout 任务使用）。
fn init_repo(dir: &PathBuf) -> String {
    let run = |args: &[&str]| Command::new("git").arg("-C").arg(dir).args(args).output().expect("git");
    std::fs::create_dir_all(dir).expect("create repo dir");
    assert!(run(&["init"]).status.success(), "git init");
    assert!(run(&["config", "user.email", "t@example.com"]).status.success());
    assert!(run(&["config", "user.name", "t"]).status.success());
    assert!(run(&["config", "commit.gpgsign", "false"]).status.success());
    std::fs::write(dir.join("file.txt"), "hello-m2").expect("write file");
    assert!(run(&["add", "."]).status.success(), "git add");
    assert!(run(&["commit", "-m", "m2"]).status.success(), "git commit");
    let out = run(&["symbolic-ref", "--short", "HEAD"]);
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// 带 source + checkout 步骤的任务（M2 契约：host 把 checkout 放 steps[0]）。
fn git_task(url: &str, git_ref: &str) -> String {
    serde_json::json!({
        "taskId": "t-git",
        "runId": "run-git",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "ws/run-git", "clean": true, "ttlSec": 3600},
        "env": {},
        "source": {"type": "git", "url": url, "ref": git_ref, "depth": 1},
        "steps": [
            {"uses": "checkout"},
            {"uses": "run", "command": "git log --oneline -1", "cwd": ".", "timeoutSec": 60}
        ],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string()
}

/// M2：带 source 的任务先 checkout（克隆本地 file:// 仓库到 ws/<runId>）
/// 再跑 run 步骤；register 请求体上报 tools 含 "git"。
#[test]
fn checkout_task_clones_repo_and_reports_git_tool() {
    if !git_ok() {
        eprintln!("git not available on this machine; skipping checkout test");
        return;
    }
    let repo = work_root("git-repo-src");
    let branch = init_repo(&repo);
    let url = format!("file:///{}", repo.display().to_string().replace('\\', "/"));
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(git_task(&url, &branch)));
    let dir = work_root("checkout");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    assert!(out.status.success(), "checkout task must succeed: {stderr}");
    let s = mock.state();
    assert!(
        s.register_tools.iter().any(|t| t == "git"),
        "register must report tools=[git]: {:?}",
        s.register_tools
    );
    assert_eq!(s.completed.len(), 1, "exactly one complete: {stderr}");
    let (task_id, status, exit_code, error) = &s.completed[0];
    assert_eq!(task_id, "t-git");
    assert_eq!(status, "succeeded");
    assert_eq!(*exit_code, 0);
    assert_eq!(error, "");

    // checkout 真的发生了：clone 落在 <workdir>/ws/<runId>，且文件可见。
    let ws = dir.join("ws").join("run-git");
    assert!(ws.join(".git").exists(), "clone must land in ws/<runId>: {stderr}");
    assert_eq!(
        std::fs::read_to_string(ws.join("file.txt")).unwrap_or_default(),
        "hello-m2"
    );
    // clone 与 run 步骤的输出都进了日志流。
    assert!(
        s.last_log_text.iter().any(|t| t.contains("m2")),
        "checkout/step logs must reach the server: {:?}",
        s.last_log_text
    );
}

/// M2 断电续跑强化：journal 里已 finished 的任务重启后再 claim 到时
/// 不再执行步骤，只补发 complete（宿主幂等）。步骤命令 exit 7，
/// 如果被执行，complete 就不会是 succeeded/0。
#[test]
fn finished_task_in_journal_is_not_reexecuted() {
    let task = serde_json::json!({
        "taskId": "t-done",
        "runId": "run-done",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "ws/run-done", "clean": true, "ttlSec": 3600},
        "env": {},
        "steps": [{"uses": "run", "command": "exit 7", "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string();
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(task));
    let dir = work_root("no-rerun");
    // 模拟断电前的 journal：该任务已 claimed + finished(succeeded)。
    std::fs::write(
        dir.join("journal.log"),
        concat!(
            "{\"event\":\"claimed\",\"taskId\":\"t-done\",\"ts\":\"2026-11-21T00:00:00.000Z\"}\n",
            "{\"event\":\"finished\",\"taskId\":\"t-done\",\"ts\":\"2026-11-21T00:00:01.000Z\",\"status\":\"succeeded\",\"exitCode\":0}\n"
        ),
    )
    .expect("seed journal");

    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(out.status.success(), "--once must exit 0 for a finished task: {stderr}");

    let s = mock.state();
    assert_eq!(s.completed.len(), 1, "exactly one (re-sent) complete: {stderr}");
    assert_eq!(
        s.completed[0],
        ("t-done".to_string(), "succeeded".to_string(), 0, String::new()),
        "complete must replay the journaled result: {stderr}"
    );
    assert!(
        !s.last_log_text.iter().any(|t| t.contains("7")),
        "the run step must not have executed: {:?}",
        s.last_log_text
    );
}

/// 只报「键在不在」，绝不 echo 值本身 —— 否则与「日志不含明文」的断言冲突。
fn env_probe(name: &str) -> String {
    if cfg!(windows) {
        format!("if defined {name} (echo {name}_PRESENT) else (echo {name}_ABSENT)")
    } else {
        format!("if [ -n \"${name}\" ]; then echo {name}_PRESENT; else echo {name}_ABSENT; fi")
    }
}

/// 带 M3 凭据声明的任务：secretRefs 给同名键，secretEnv 给「env -> ref」映射。
/// 两个 run 步骤：第二个步骤同时用来证明同一 task 内不会重复换值。
fn secret_task() -> String {
    serde_json::json!({
        "taskId": "t-sec",
        "runId": "run-sec",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "tasks/run-sec", "clean": true, "ttlSec": 3600},
        "env": {"CI": "1"},
        "projectId": "p1",
        "secretRefs": ["TOKEN"],
        "secretEnv": [{"env": "DB_PASSWORD", "ref": "DB_PASSWORD"}],
        "steps": [
            {"uses": "run", "command": env_probe("TOKEN"), "cwd": ".", "timeoutSec": 60},
            {"uses": "run", "command": env_probe("DB_PASSWORD"), "cwd": ".", "timeoutSec": 60}
        ],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string()
}

/// 递归扫工作目录：把任何出现明文的地方都记下来（证明「不落盘」）。
fn scan_dir_for_secrets(root: &PathBuf, needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if let Ok(bytes) = std::fs::read(&path) {
                let text = String::from_utf8_lossy(&bytes);
                for n in needles {
                    if text.contains(n) {
                        hits.push(format!("{} contains {n}", path.display()));
                    }
                }
            }
        }
    }
    hits
}

/// M3：任务体只有名字；/credentials 换一次值 -> 落进子进程 env（secretRefs 同名 +
/// secretEnv 映射）-> 明文不出现在日志、complete 请求体、runner stderr 与任何落盘文件。
#[test]
fn secret_refs_are_exchanged_for_env_and_never_leak() {
    const TOKEN_VAL: &str = "s3cr3t-token-value";
    const PW_VAL: &str = "pw-value-xyz";
    let mut values = HashMap::new();
    values.insert("TOKEN".to_string(), TOKEN_VAL.to_string());
    values.insert("DB_PASSWORD".to_string(), PW_VAL.to_string());
    let mock = start_mock_with_creds(
        RegisterMode::Ok,
        HeartbeatMode::Ok,
        Some(secret_task()),
        Some(CredMode::Ok {
            values,
            expires_at: "2999-01-01T00:00:00.000Z".to_string(),
        }),
    );
    let dir = work_root("secret-refs");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let s = mock.state();

    // ① 只换了一次，且请求内容正确。
    assert_eq!(s.cred_calls, 1, "同一 task 内的两个步骤只换一次值：{stderr}");
    assert_eq!(
        s.cred_names,
        vec!["TOKEN".to_string(), "DB_PASSWORD".to_string()],
        "names 应为 secretRefs 与 secretEnv 引用的并集"
    );
    assert_eq!(s.cred_task_id, "t-sec");
    assert_eq!(s.cred_runner_id, "r1");
    assert_eq!(s.cred_bearer, RUNNER_TOKEN, "凭据端点同样要带 runner token");

    // ② 子进程 env 里真的拿到了值（两个来源各一路）。
    assert!(
        s.last_log_text.iter().any(|t| t.contains("TOKEN_PRESENT")),
        "secretRefs 的值没进子进程 env: {:?} {stderr}",
        s.last_log_text
    );
    assert!(
        s.last_log_text
            .iter()
            .any(|t| t.contains("DB_PASSWORD_PRESENT")),
        "secretEnv 映射没落到子进程 env: {:?} {stderr}",
        s.last_log_text
    );
    assert!(
        !s.last_log_text.iter().any(|t| t.contains("_ABSENT")),
        "不应有缺席标记: {:?}",
        s.last_log_text
    );
    assert_eq!(s.completed.len(), 1, "exactly one complete: {stderr}");
    let (_, status, exit_code, error) = &s.completed[0];
    assert_eq!(status, "succeeded", "{stderr} {error}");
    assert_eq!(*exit_code, 0);

    // ③ 明文不许出现在任何出口。
    for line in &s.last_log_text {
        assert!(!line.contains(TOKEN_VAL), "日志行泄露了 TOKEN 明文: {line}");
        assert!(!line.contains(PW_VAL), "日志行泄露了 DB_PASSWORD 明文: {line}");
    }
    for body in &s.complete_bodies {
        assert!(!body.contains(TOKEN_VAL), "complete 请求体泄露了 TOKEN 明文: {body}");
        assert!(!body.contains(PW_VAL), "complete 请求体泄露了 DB_PASSWORD 明文: {body}");
    }
    assert!(!stderr.contains(TOKEN_VAL), "runner stderr 泄露了 TOKEN 明文: {stderr}");
    assert!(!stderr.contains(PW_VAL), "runner stderr 泄露了 DB_PASSWORD 明文: {stderr}");
    let leaked = scan_dir_for_secrets(&dir, &[TOKEN_VAL, PW_VAL]);
    assert!(leaked.is_empty(), "明文落盘了: {leaked:?}");
}

/// M3 fail closed：换不到值就 complete 成 failed（带 code），一个步骤都不跑。
#[test]
fn credentials_failure_fails_closed() {
    let mock = start_mock_with_creds(
        RegisterMode::Ok,
        HeartbeatMode::Ok,
        Some(secret_task()),
        Some(CredMode::Deny {
            status: 403,
            code: "CREDENTIALS_DENIED".to_string(),
        }),
    );
    let dir = work_root("cred-deny");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let s = mock.state();

    assert_eq!(s.cred_calls, 1, "403 是致命错误，不许重试：{stderr}");
    assert_eq!(s.completed.len(), 1, "任务必须 complete 成 failed: {stderr}");
    let (_, status, exit_code, error) = &s.completed[0];
    assert_eq!(status, "failed", "{stderr}");
    assert_eq!(*exit_code, -1, "{stderr}");
    assert!(error.contains("凭据获取失败"), "error 要说明是凭据问题: {error}");
    assert!(error.contains("CREDENTIALS_DENIED"), "error 要带上 code: {error}");
    assert!(
        !s.last_log_text
            .iter()
            .any(|t| t.contains("TOKEN_PRESENT") || t.contains("TOKEN_ABSENT")),
        "fail closed: 一个步骤都不许跑: {:?}",
        s.last_log_text
    );
}

fn post_logs(server: &str, body: &str) -> String {
    let addr = server.trim_start_matches("http://");
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    let req = format!(
        "POST /api/plugins/cicd/runner/v2/logs HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {RUNNER_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
}


/// M3 命中路径：lookup 命中 -> 下载 blob -> 系统 tar 解包到 ws 根。
#[cfg(windows)]
#[test]
fn cache_hit_restores_files_via_system_tar() {
    assert!(tar_ok(), "缓存用例需要系统 tar");
    // 造一个含 dist/hit.txt 的 tar.gz，当作宿主侧的缓存字节。
    let src = work_root("cache-hit-src");
    std::fs::create_dir_all(src.join("dist")).unwrap();
    std::fs::write(src.join("dist/hit.txt"), "cached").unwrap();
    let archive = src.join("cache.tar.gz");
    let packed = Command::new("tar")
        .args([
            "-czf",
            archive.to_str().unwrap(),
            "-C",
            src.to_str().unwrap(),
            "dist",
        ])
        .status()
        .expect("run tar");
    assert!(packed.success(), "tar packing must succeed");
    let blob = std::fs::read(&archive).unwrap();
    assert!(!blob.is_empty(), "archive must not be empty");

    let task = serde_json::json!({
        "taskId": "t-cache",
        "runId": "run-cache",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "run-cache", "clean": true, "ttlSec": 3600},
        "env": {"CI": "1"},
        "cache": [{"key": "k1", "paths": ["dist"], "restoreKeys": ["k"], "mode": "both"}],
        "steps": [{"uses": "run",
            "command": "if exist dist\\hit.txt (echo CACHE_RESTORED) else (echo CACHE_MISSING)",
            "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string();
    let mock = start_mock_with_cache(
        RegisterMode::Ok,
        HeartbeatMode::Ok,
        Some(task),
        CacheMode::Hit {
            digest: "sha256:abc".to_string(),
            blob,
        },
    );
    let dir = work_root("cache-hit");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(out.status.success(), "命中路径不能改变任务结论:\n{stderr}");

    let s = mock.state();
    assert!(s.cache_lookups >= 1, "must look up the declared cache");
    assert_eq!(s.cache_gets, 1, "命中后必须下载一次 blob:\n{stderr}");
    assert_eq!(
        s.completed.first().map(|c| c.1.as_str()),
        Some("succeeded"),
        "task must succeed:\n{stderr}"
    );
    assert!(
        s.last_log_text.iter().any(|t| t.contains("CACHE_RESTORED")),
        "解包后的文件必须能被步骤看到: {:?}",
        s.last_log_text
    );
    assert!(
        dir.join("ws").join("run-cache").join("dist").join("hit.txt").exists(),
        "dist/hit.txt 必须出现在 ws 根下"
    );
}

/// M3 保存路径 + 心跳负载：成功任务上传 blob，心跳里带 running 与 cache 计数。
#[cfg(windows)]
#[test]
fn cache_save_uploads_blob_and_heartbeat_reports_stats() {
    let task = serde_json::json!({
        "taskId": "t-save",
        "runId": "run-save",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "run-save", "clean": true, "ttlSec": 3600},
        "env": {"CI": "1"},
        "cache": [{"key": "k1", "paths": ["dist"], "restoreKeys": ["k"], "mode": "save"}],
        "steps": [{"uses": "run",
            "command": "mkdir dist & echo saved>dist\\out.txt",
            "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string();
    let mock = start_mock_with_cache(
        RegisterMode::Ok,
        HeartbeatMode::Ok,
        Some(task),
        CacheMode::Miss,
    );
    let dir = work_root("cache-save");
    let mut child = spawn_runner(&mock.server(), &dir);
    let done = wait_until(&mock, |s| !s.completed.is_empty(), Duration::from_secs(60));
    // 保存发生在 complete 之前，之后的一次心跳必须带上 saves 计数。
    let seen = wait_until(
        &mock,
        |s| {
            s.heartbeat_stats.iter().any(|v| {
                v.get("cache")
                    .and_then(|c| c.get("saves"))
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0)
                    >= 1
            })
        },
        Duration::from_secs(20),
    );
    let _ = child.kill();
    let _ = child.wait();
    assert!(done, "任务必须在 60s 内完成");
    assert!(seen, "心跳必须上报 cache.saves >= 1");

    let s = mock.state();
    assert_eq!(
        s.completed.first().map(|c| c.1.as_str()),
        Some("succeeded"),
        "任务必须成功: {:?}",
        s.completed
    );
    assert!(!s.cache_puts.is_empty(), "task 成功后必须 PUT 缓存");
    assert_eq!(s.cache_puts[0].0, "k1", "PUT 的 key 必须是声明的 key");
    assert!(s.cache_puts[0].1 > 0, "PUT body 不能为空");
    assert!(
        s.heartbeat_stats.iter().any(|v| v.get("running").is_some()),
        "heartbeat 必须带 stats.running: {:?}",
        s.heartbeat_stats
    );
    assert!(
        s.heartbeat_stats.iter().any(|v| {
            v.get("cache")
                .and_then(|c| c.get("saves"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0)
                >= 1
        }),
        "heartbeat stats.cache.saves 至少为 1: {:?}",
        s.heartbeat_stats
    );
}

/// 缓存是加速层不是正确性层：lookup 500 时任务照旧成功。
#[cfg(windows)]
#[test]
fn cache_lookup_failure_is_fail_open() {
    let task = serde_json::json!({
        "taskId": "t-failopen",
        "runId": "run-failopen",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "run-failopen", "clean": true, "ttlSec": 3600},
        "env": {"CI": "1"},
        "cache": [{"key": "k1", "paths": ["dist"], "restoreKeys": ["k"], "mode": "both"}],
        "steps": [{"uses": "run", "command": "echo ok", "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string();
    let mock = start_mock_with_cache(
        RegisterMode::Ok,
        HeartbeatMode::Ok,
        Some(task),
        CacheMode::Error(503),
    );
    let dir = work_root("cache-fail-open");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(out.status.success(), "缓存失败不能改变任务结论:\n{stderr}");
    let s = mock.state();
    assert!(s.cache_lookups >= 1, "must still attempt the lookup:\n{stderr}");
    assert_eq!(
        s.completed.first().map(|c| c.1.as_str()),
        Some("succeeded"),
        "lookup 失败必须 fail-open:\n{stderr}"
    );
}

/// 后台周期心跳：长任务执行期间仍按 heartbeatSec 上报，且 stats.running=1 可见。
#[test]
#[cfg(windows)]
fn heartbeat_ticks_during_long_task() {
    let task = serde_json::json!({
        "taskId": "t-hb",
        "runId": "run-hb",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "tasks/run-hb", "clean": true, "ttlSec": 3600},
        "env": {},
        "steps": [{"uses": "run", "command": "node -e \"setTimeout(function(){},4000)\"", "cwd": ".", "timeoutSec": 120}],
        "logStream": {"batchMs": 50},
        "artifacts": []
    })
    .to_string();
    // heartbeatSec=1，任务里跑约 4s 的步骤：心跳必须与 execute 解耦。
    let mock = start_mock_with_hb(RegisterMode::Ok, HeartbeatMode::Ok, Some(task), 1);
    let dir = work_root("hb-long-task");
    let mut child = spawn_runner(&mock.server(), &dir);

    let done = wait_until(&mock, |s| !s.completed.is_empty(), Duration::from_secs(60));
    let s = mock.state();
    let total = s.heartbeats;
    let running_ticks = s
        .heartbeat_stats
        .iter()
        .filter(|v| v.get("running").and_then(|r| r.as_u64()) == Some(1))
        .count();
    let _ = child.kill();
    let _ = child.wait();

    assert!(done, "任务必须在 60s 内完成（heartbeats={total}）");
    assert_eq!(
        s.completed.first().map(|c| c.1.as_str()),
        Some("succeeded"),
        "长任务结论不能变: {:?} log={:?}",
        s.completed, s.last_log_text
    );
    assert!(total >= 2, "heartbeatSec=1 下总心跳应 >= 2，实际 {total}");
    assert!(
        running_ticks >= 2,
        "执行期间（stats.running=1）应至少收到 2 次心跳，实际 {running_ticks}: {:?}",
        s.heartbeat_stats
    );
}
/// 用系统 tar 列出制品包成员（顺带证明 body 真是 tar.gz）。
fn tar_list(blob: &[u8], dir: &std::path::Path) -> String {
    std::fs::create_dir_all(dir).expect("create unpack dir");
    let archive = dir.join("artifact.tar.gz");
    std::fs::write(&archive, blob).expect("write blob");
    let out = std::process::Command::new("tar")
        .arg("-tzf")
        .arg(&archive)
        .output()
        .expect("run tar");
    assert!(
        out.status.success(),
        "tar -tzf 必须能解开制品包: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn complete_artifacts(s: &State) -> Vec<serde_json::Value> {
    let body = s.complete_bodies.last().expect("complete 必须被调用");
    let json: serde_json::Value = serde_json::from_str(body).expect("complete body JSON");
    json.get("artifacts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// M4：两个声明各发一次 PUT，complete 的清单与上传回执一致。
#[cfg(windows)]
#[test]
fn artifacts_are_uploaded_and_reported_on_complete() {
    assert!(tar_ok(), "本机必须有可用 tar");
    let task = serde_json::json!({
        "taskId": "t-art",
        "runId": "run-art",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "run-art", "clean": true, "ttlSec": 3600},
        "env": {},
        "artifacts": [
            {"name": "web-dist", "paths": ["dist"], "optional": false},
            {"name": "report", "paths": ["reports/*.txt"], "optional": false}
        ],
        "steps": [{"uses": "run",
            "command": "mkdir dist & mkdir reports & echo a>dist\\a.txt & echo r>reports\\r.txt",
            "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50}
    })
    .to_string();
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(task));
    let dir = work_root("collect-ok");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(out.status.success(), "collect 不能改变任务结论:\n{stderr}");

    let s = mock.state();
    assert_eq!(
        s.completed.first().map(|c| c.1.as_str()),
        Some("succeeded"),
        "任务必须成功: {:?}\n{stderr}",
        s.completed
    );
    assert_eq!(s.artifact_puts.len(), 2, "两个声明各一次 PUT: {:?}", s.artifact_puts.iter().map(|p| &p.0).collect::<Vec<_>>());
    let mut names: Vec<String> = s.artifact_puts.iter().map(|(n, _)| n.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["report".to_string(), "web-dist".to_string()]);

    for (name, blob) in &s.artifact_puts {
        assert!(!blob.is_empty(), "{name} 的 body 不能为空");
        let listing = tar_list(blob, &dir.join("unpack"));
        let want = if name == "web-dist" { "dist/a.txt" } else { "reports/r.txt" };
        assert!(listing.contains(want), "{name} 包内必须有 {want}: {listing}");
    }

    let arts = complete_artifacts(&s);
    assert_eq!(arts.len(), 2, "complete 必须报两个制品: {arts:?}");
    for a in &arts {
        let name = a.get("name").and_then(|v| v.as_str()).expect("name");
        let digest = a.get("digest").and_then(|v| v.as_str()).expect("digest");
        assert_eq!(digest, format!("sha256:art-{name}"), "digest 必须来自上传回执");
        assert!(a.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0) > 0, "bytes 必须 > 0");
    }
}

/// M4：没有 artifacts 声明就一次 PUT 都不发。
#[cfg(windows)]
#[test]
fn no_artifacts_declared_uploads_nothing() {
    let task = serde_json::json!({
        "taskId": "t-noart",
        "runId": "run-noart",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "run-noart", "clean": true, "ttlSec": 3600},
        "env": {},
        "artifacts": [],
        "steps": [{"uses": "run", "command": "echo ok", "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50}
    })
    .to_string();
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(task));
    let dir = work_root("collect-none");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    assert!(out.status.success());
    let s = mock.state();
    assert!(s.artifact_puts.is_empty(), "无声明不能发 PUT: {:?}", s.artifact_puts.len());
    assert_eq!(s.completed.first().map(|c| c.1.as_str()), Some("succeeded"));
    assert!(complete_artifacts(&s).is_empty(), "空清单不必序列化，读出来也应为空");
}

/// M4：一个声明 glob 无命中、另一个命中 —— 只有命中的被上传。
#[cfg(windows)]
#[test]
fn artifact_glob_miss_is_skipped() {
    assert!(tar_ok());
    let task = serde_json::json!({
        "taskId": "t-artmiss",
        "runId": "run-artmiss",
        "stepIndex": 0,
        "stageId": "build",
        "leaseSec": 600,
        "workspace": {"root": "run-artmiss", "clean": true, "ttlSec": 3600},
        "env": {},
        "artifacts": [
            {"name": "missing", "paths": ["nope/**"], "optional": false},
            {"name": "hit", "paths": ["dist/**"], "optional": false}
        ],
        "steps": [{"uses": "run",
            "command": "mkdir dist & echo a>dist\\a.txt",
            "cwd": ".", "timeoutSec": 60}],
        "logStream": {"batchMs": 50}
    })
    .to_string();
    let mock = start_mock(RegisterMode::Ok, HeartbeatMode::Ok, Some(task));
    let dir = work_root("collect-miss");
    let out = run_once(&mock.server(), &dir, JOIN_TOKEN);
    assert!(out.status.success());
    let s = mock.state();
    assert_eq!(s.artifact_puts.len(), 1, "只有命中的声明该上传");
    assert_eq!(s.artifact_puts[0].0, "hit");
    let listing = tar_list(&s.artifact_puts[0].1, &dir.join("unpack"));
    assert!(listing.contains("dist/a.txt"), "包内必须含命中的文件: {listing}");
    let arts = complete_artifacts(&s);
    assert_eq!(arts.len(), 1);
    assert_eq!(arts[0].get("name").and_then(|v| v.as_str()), Some("hit"));
}

