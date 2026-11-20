//! Runner lifecycle: register -> recovery -> claim loop -> execute -> complete.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use tokio::sync::{mpsc, watch};
use tokio::time::{timeout, Instant};

use crate::cli::Args;
use crate::client::{classify, Backoff, Client, FailureKind, CLAIM_WAIT_MS};
use crate::exec::{run_command, EmittedLine, StepOutcome};
use crate::journal::Journal;
use crate::protocol::*;
use crate::seq::SeqAlloc;

const DEFAULT_BATCH_MS: u64 = 250;
const DEFAULT_STEP_TIMEOUT_SEC: u64 = 600;
const DEFAULT_HEARTBEAT_SEC: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunOutcome {
    pub status: TaskStatus,
    pub exit_code: i64,
}

fn log(msg: &str) {
    eprintln!("[runner] {msg}");
}

pub async fn run(args: Args) -> i32 {
    let (tx, rx) = watch::channel(false);
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        let _ = tx.send(true);
    });
    run_with_cancel(args, rx).await
}

/// Resolve on SIGINT (Ctrl-C) or SIGTERM; the runner then finishes the current
/// step as `canceled` instead of dying mid-task.
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Entry point; `cancel` becoming true (SIGINT/SIGTERM) cancels cleanly.
pub async fn run_with_cancel(args: Args, cancel: watch::Receiver<bool>) -> i32 {
    match run_inner(&args, cancel).await {
        Ok(code) => code,
        Err(e) => {
            log(&format!("fatal: {e:#}"));
            1
        }
    }
}

async fn run_inner(args: &Args, mut cancel: watch::Receiver<bool>) -> anyhow::Result<i32> {
    tokio::fs::create_dir_all(&args.workdir)
        .await
        .with_context(|| format!("cannot create workdir {:?}", args.workdir))?;

    let mut client = Client::new(&args.server, args.runner_id.clone(), args.insecure)?;
    let heartbeat_sec = match register_with_retry(args, &mut client, &mut cancel).await? {
        Some(hb) => hb,
        None => return Ok(0), // canceled while registering
    };

    let journal = Journal::new(args.workdir.join("journal.log"));
    if !replay_journal(&journal, &client, &mut cancel).await? {
        return Ok(0);
    }

    let mut idle_backoff = Backoff::new();
    loop {
        if *cancel.borrow() {
            log("canceled; exiting");
            return Ok(0);
        }

        log("claiming...");
        let claim = tokio::select! {
            r = client.claim(CLAIM_WAIT_MS) => r,
            _ = wait_cancel(&mut cancel) => {
                log("canceled while claiming; exiting");
                return Ok(0);
            }
        };

        let claim = match claim {
            Ok(c) => {
                idle_backoff.reset();
                c
            }
            Err(e) if matches!(classify(&e), FailureKind::Fatal) => {
                log(&format!("claim rejected: {e}; exiting"));
                return Ok(1);
            }
            Err(e) => {
                log(&format!("claim failed: {e}; backing off"));
                idle_backoff.sleep().await;
                continue;
            }
        };

        let task = match claim.task {
            Some(t) => t,
            None => {
                match heartbeat_with_retry(&client, &mut cancel).await {
                    Ok(()) => log("heartbeat ok"),
                    Err(e) => log(&format!("heartbeat aborted: {e:#}")),
                }
                if *cancel.borrow() {
                    return Ok(0);
                }
                let nap = Duration::from_secs(heartbeat_sec.max(1));
                log(&format!("no task; sleeping {}s", nap.as_secs()));
                tokio::select! {
                    _ = tokio::time::sleep(nap) => {}
                    _ = wait_cancel(&mut cancel) => {
                        log("canceled while idle; exiting");
                        return Ok(0);
                    }
                }
                continue;
            }
        };

        log(&format!(
            "claimed task {} (run {}, {} step(s))",
            task.task_id,
            task.run_id,
            task.steps.len()
        ));
        if let Err(e) = journal.append_claimed(&task.task_id) {
            log(&format!("journal write failed: {e}"));
        }

        let outcome = execute_task(args, &client, &task, &mut cancel).await;
        log(&format!(
            "task {} -> {} (exit {})",
            task.task_id,
            outcome.status.as_str(),
            outcome.exit_code
        ));
        if let Err(e) =
            journal.append_finished(&task.task_id, outcome.status.as_str(), outcome.exit_code)
        {
            log(&format!("journal write failed: {e}"));
        }

        if args.once {
            log("--once: exiting after one task");
            return Ok(if outcome.status == TaskStatus::Succeeded { 0 } else { 1 });
        }
    }
}

async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    loop {
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        if *rx.borrow() {
            return;
        }
    }
}

/// Re-send complete for journal entries that were claimed but never finished.
/// Returns false if canceled mid-replay.
async fn replay_journal(
    journal: &Journal,
    client: &Client,
    cancel: &mut watch::Receiver<bool>,
) -> anyhow::Result<bool> {
    for task_id in journal.recover() {
        log(&format!("recovery: re-sending complete for orphaned task {task_id}"));
        let req = CompleteRequest {
            runner_id: client.runner_id().to_string(),
            task_id: task_id.clone(),
            status: TaskStatus::Failed,
            exit_code: -1,
            error: "runner crashed before reporting completion".to_string(),
        };
        if !complete_until_ok(client, &req, cancel).await {
            log(&format!("recovery: complete for {task_id} aborted"));
            return Ok(false);
        }
        let _ = journal.append_finished(&task_id, "failed", -1);
    }
    Ok(true)
}

fn credentials_path(workdir: &Path) -> PathBuf {
    workdir.join("credentials.json")
}

fn read_credentials(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_credentials(path: &Path, runner_id: &str, token: &str) -> std::io::Result<()> {
    let mut doc = read_credentials(path);
    let obj = doc.as_object_mut().expect("object");
    obj.insert(
        runner_id.to_string(),
        serde_json::json!({
            "runnerId": runner_id,
            "runnerToken": token,
            "savedAt": crate::util::iso_now(),
        }),
    );
    let text = serde_json::to_string_pretty(&doc)?;
    std::fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Returns Some(heartbeatSec) when registered, None when canceled first.
async fn register_with_retry(
    args: &Args,
    client: &mut Client,
    cancel: &mut watch::Receiver<bool>,
) -> anyhow::Result<Option<u64>> {
    let labels: Vec<String> = args
        .labels
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let req = RegisterRequest {
        runner_id: args.runner_id.clone(),
        labels,
        version: env!("CARGO_PKG_VERSION").to_string(),
        capacity: args.capacity,
        join_token: args.join_token.clone(),
    };
    let mut backoff = Backoff::new();
    loop {
        log(&format!("registering runner '{}' ...", args.runner_id));
        let res = tokio::select! {
            r = client.register(&req) => r,
            _ = wait_cancel(cancel) => return Ok(None),
        };
        match res {
            Ok(resp) => {
                log(&format!(
                    "registered: heartbeatSec={} offlineAfterSec={}",
                    resp.heartbeat_sec, resp.offline_after_sec
                ));
                client.set_token(resp.runner_token.clone());
                let cred_path = credentials_path(&args.workdir);
                if let Err(e) = write_credentials(&cred_path, &args.runner_id, &resp.runner_token) {
                    log(&format!("warning: cannot write credentials.json: {e}"));
                }
                return Ok(Some(if resp.heartbeat_sec == 0 {
                    DEFAULT_HEARTBEAT_SEC
                } else {
                    resp.heartbeat_sec
                }));
            }
            Err(e) if matches!(classify(&e), FailureKind::Fatal) => {
                return Err(anyhow!("register rejected: {e}"));
            }
            Err(e) => {
                log(&format!("register failed: {e}; retrying with backoff"));
                backoff.sleep().await;
            }
        }
    }
}

async fn heartbeat_with_retry(
    client: &Client,
    cancel: &mut watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let mut backoff = Backoff::new();
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        let res = tokio::select! {
            r = client.heartbeat() => r,
            _ = wait_cancel(cancel) => return Err(anyhow!("canceled")),
        };
        match res {
            Ok(_) => return Ok(()),
            Err(e) => {
                if attempts >= 3 || matches!(classify(&e), FailureKind::Fatal) {
                    return Err(anyhow!("{e}"));
                }
                log(&format!("heartbeat failed ({attempts}/3): {e}"));
                backoff.sleep().await;
            }
        }
    }
}

/// POST /logs with up to 3 attempts, then drop the batch (idempotent server side).
async fn send_logs_with_retry(client: &Client, task_id: &str, lines: Vec<LogLine>) -> anyhow::Result<()> {
    let req = LogsRequest {
        runner_id: client.runner_id().to_string(),
        task_id: task_id.to_string(),
        lines,
    };
    for attempt in 1..=3u32 {
        match client.logs(&req).await {
            Ok(resp) => {
                if let Some(code) = resp.code.as_deref() {
                    log(&format!("logs: accepted={} dropped={} code={code}", resp.accepted, resp.dropped));
                }
                return Ok(());
            }
            Err(e) if attempt == 3 => {
                log(&format!("logs batch dropped after 3 attempts: {e}"));
                return Ok(());
            }
            Err(e) => {
                log(&format!("logs attempt {attempt}/3 failed: {e}"));
                tokio::time::sleep(Duration::from_millis(200 * attempt as u64)).await;
            }
        }
    }
    Ok(())
}

/// complete must land eventually: retry with backoff until accepted.
/// Returns false only when canceled while retrying.
async fn complete_until_ok(
    client: &Client,
    req: &CompleteRequest,
    cancel: &mut watch::Receiver<bool>,
) -> bool {
    let mut backoff = Backoff::new();
    loop {
        let res = tokio::select! {
            r = client.complete(req) => r,
            _ = wait_cancel(cancel) => return false,
        };
        match res {
            Ok(_) => return true,
            Err(e) => {
                log(&format!("complete failed: {e}; retrying"));
                if matches!(classify(&e), FailureKind::Fatal) {
                    // Definitive rejection (401/403): stop rather than hammer the server.
                    log("complete rejected by server; giving up this task");
                    return true;
                }
                // Even when complete keeps failing we must still flush logs first,
                // so retry is bounded by cancellation, not by an attempt count.
                if *cancel.borrow() {
                    return false;
                }
                backoff.sleep().await;
            }
        }
    }
}

/// Execute a claimed task: prepare workspace, run steps, stream logs, complete.
pub async fn execute_task(
    args: &Args,
    client: &Client,
    task: &Task,
    cancel: &mut watch::Receiver<bool>,
) -> RunOutcome {
    let ws_root = args.workdir.join(&task.workspace.root);
    if let Err(e) = prepare_workspace(&ws_root, task.workspace.clean).await {
        log(&format!("workspace error: {e:#}"));
        let req = CompleteRequest {
            runner_id: args.runner_id.clone(),
            task_id: task.task_id.clone(),
            status: TaskStatus::Failed,
            exit_code: -1,
            error: format!("workspace setup failed: {e}"),
        };
        let _ = complete_until_ok(client, &req, cancel).await;
        return RunOutcome {
            status: TaskStatus::Failed,
            exit_code: -1,
        };
    }

    let batch_ms = task.log_stream.batch_ms.unwrap_or(DEFAULT_BATCH_MS).max(10);
    let (line_tx, line_rx) = mpsc::unbounded_channel::<EmittedLine>();
    let seq = Arc::new(std::sync::Mutex::new(SeqAlloc::new(1)));
    let (step_cancel_tx, step_cancel_rx) = watch::channel(false);

    // Log drainer: batches lines by batchMs and posts them (final flush on close).
    let task_id = task.task_id.clone();
    let drainer_client = client.clone_for_task();
    let drainer = tokio::spawn(async move {
        log_drainer(line_rx, drainer_client, task_id, batch_ms).await
    });

    // External cancel -> step cancel.
    let mut ext_cancel = cancel.clone();
    let forward = tokio::spawn(async move {
        wait_cancel(&mut ext_cancel).await;
        let _ = step_cancel_tx.send(true);
    });

    let mut canceled = false;
    let mut failed: Option<(i64, String)> = None;
    let mut last_exit: Option<i64> = None;

    for (idx, step) in task.steps.iter().enumerate() {
        if *cancel.borrow() {
            canceled = true;
            break;
        }
        if step.uses != "run" {
            failed = Some((
                -1,
                format!("step {idx}: unsupported step kind \"{}\"", step.uses),
            ));
            break;
        }
        let command = step.command.clone().unwrap_or_default();
        let step_cwd = ws_root.join(step.cwd.clone().unwrap_or_else(|| ".".to_string()));
        let timeout_sec = step.timeout_sec.unwrap_or(DEFAULT_STEP_TIMEOUT_SEC);

        log(&format!("step {idx} (timeout {timeout_sec}s): {command}"));
        let res = run_command(
            &command,
            &step_cwd,
            &task.env,
            Duration::from_secs(timeout_sec),
            seq.clone(),
            Some(line_tx.clone()),
            step_cancel_rx.clone(),
        )
        .await;

        match res {
            Ok(StepOutcome::Exited(code)) => {
                last_exit = Some(code);
                if code != 0 {
                    failed = Some((code, format!("step {idx} failed with exit code {code}")));
                    break;
                }
            }
            Ok(StepOutcome::TimedOut) => {
                failed = Some((124, format!("step timeout after {timeout_sec}s")));
                break;
            }
            Ok(StepOutcome::Canceled) => {
                canceled = true;
                break;
            }
            Err(e) => {
                failed = Some((-1, format!("step {idx} spawn error: {e}")));
                break;
            }
        }
    }

    drop(line_tx);
    // Wait for the drainer to flush every buffered line before completing.
    if timeout(Duration::from_secs(60), drainer).await.is_err() {
        log("warning: log drainer did not finish within 60s");
    }
    forward.abort();

    let (status, exit_code, error) = if canceled {
        (TaskStatus::Canceled, -1i64, "canceled by signal".to_string())
    } else if let Some((code, err)) = failed {
        (TaskStatus::Failed, code, err)
    } else {
        (TaskStatus::Succeeded, last_exit.unwrap_or(0), String::new())
    };

    let req = CompleteRequest {
        runner_id: args.runner_id.clone(),
        task_id: task.task_id.clone(),
        status,
        exit_code,
        error,
    };
    if !complete_until_ok(client, &req, cancel).await {
        log("complete aborted by cancellation");
    }

    RunOutcome { status, exit_code }
}

async fn log_drainer(
    mut line_rx: mpsc::UnboundedReceiver<EmittedLine>,
    client: Client,
    task_id: String,
    batch_ms: u64,
) {
    let batch_time = Duration::from_millis(batch_ms);
    let mut pending: Vec<LogLine> = vec![];
    let mut due: Option<Instant> = None;
    loop {
        let mut tick = Box::pin(match due {
            Some(d) => tokio::time::sleep_until(d),
            None => tokio::time::sleep(Duration::from_secs(3600)),
        });
        tokio::select! {
            msg = line_rx.recv() => match msg {
                Some(line) => {
                    pending.push(LogLine { seq: line.seq, text: line.text });
                    if due.is_none() {
                        due = Some(Instant::now() + batch_time);
                    }
                }
                None => break,
            },
            _ = &mut tick => {
                if !pending.is_empty() {
                    let lines = std::mem::take(&mut pending);
                    let _ = send_logs_with_retry(&client, &task_id, lines).await;
                }
                due = None;
            }
        }
    }
    if !pending.is_empty() {
        let lines = std::mem::take(&mut pending);
        let _ = send_logs_with_retry(&client, &task_id, lines).await;
    }
}

async fn prepare_workspace(root: &PathBuf, clean: bool) -> anyhow::Result<()> {
    if clean && root.exists() {
        tokio::fs::remove_dir_all(root)
            .await
            .with_context(|| format!("clean {root:?}"))?;
    }
    tokio::fs::create_dir_all(root)
        .await
        .with_context(|| format!("create {root:?}"))?;
    Ok(())
}
