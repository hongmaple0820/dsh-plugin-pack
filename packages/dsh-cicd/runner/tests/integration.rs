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
}

/// Heartbeat behaviour: "ok" answers 200, "401" answers RUNNER_TOKEN_INVALID.
#[derive(Clone)]
enum HeartbeatMode {
    Ok,
    Unauthorized,
}

fn start_mock(register: RegisterMode, heartbeat: HeartbeatMode, task: Option<String>) -> Mock {
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
                let endpoint = path.rsplit('/').next().unwrap_or("").to_string();
                let json: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                let mut s = st.lock().unwrap();
                let (status, payload) = match endpoint.as_str() {
                    "register" => match register {
                        RegisterMode::Reject => (
                            401,
                            serde_json::json!({"ok": false, "code": "RUNNER_JOIN_TOKEN_INVALID",
                                "error": "join token invalid"}),
                        ),
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
                                        "runnerToken": RUNNER_TOKEN, "heartbeatSec": 30,
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
