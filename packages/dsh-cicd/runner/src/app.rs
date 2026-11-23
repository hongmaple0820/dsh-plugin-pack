//! Runner lifecycle: register -> recovery -> claim loop -> execute -> complete.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use tokio::sync::{mpsc, watch};
use tokio::time::{timeout, Instant};

use crate::cache::{self, CacheRunner};
use crate::collect;
use crate::cli::Args;
use crate::client::{classify, Backoff, Client, FailureKind, CLAIM_WAIT_MS};
use crate::cred::CredCache;
use crate::exec::{run_command, EmittedLine, StepOutcome};
use crate::journal::Journal;
use crate::protocol::*;
use crate::seq::SeqAlloc;
use crate::workspace::{self, GcState};

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

    // M2 TTL GC：后台每 60s 扫 <workdir>/ws/，回收过期且不活跃的 run 目录。
    let gc = GcState::default();
    tokio::spawn(workspace::gc_loop(args.workdir.clone(), gc.clone()));

    // M3 缓存层：计数器给心跳读取，压缩包落 <workdir>/cache/（不在 ws/ 里）。
    let cache = CacheRunner::new(&args.workdir);
    // 本 runner 串行执行：跑任务时为 1，空闲为 0。
    let running = Arc::new(AtomicU32::new(0));

    // 心跳与 claim/execute 解耦：后台按 heartbeat_sec 周期上报（注册后立刻一次），
    // 否则宿主 liveness 会把超过 heartbeatSec*3 的正常构建判成 RUNNER_OFFLINE。
    let _hb = spawn_heartbeat(
        client.clone(),
        cache.clone(),
        running.clone(),
        cancel.clone(),
        heartbeat_sec,
    );

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

        // M2 断电续跑强化：journal 里已 finished 的任务不重跑（避免成功任务
        // 被重复执行），只补发一次 complete —— 宿主侧 complete 是幂等的。
        if let Some((status, exit_code)) = journal.finished(&task.task_id) {
            log(&format!(
                "task {} already finished in journal ({status}); re-sending complete only",
                task.task_id
            ));
            let st = status_from_str(&status);
            let req = CompleteRequest {
                runner_id: args.runner_id.clone(),
                task_id: task.task_id.clone(),
                status: st,
                exit_code,
                error: String::new(),
                // 重放路径没有制品清单（journal 不存），缺失判定交宿主。
                artifacts: Vec::new(),
            };
            if !complete_until_ok(&client, &req, &mut cancel).await {
                return Ok(0);
            }
            if args.once {
                log("--once: exiting after one task");
                return Ok(if st == TaskStatus::Succeeded { 0 } else { 1 });
            }
            continue;
        }

        if let Err(e) = journal.append_claimed(&task.task_id) {
            log(&format!("journal write failed: {e}"));
        }
        // 记录该 run 的 TTL 并标记活跃，供 GC 判断（活跃目录不能删）。
        gc.set_ttl(&task.run_id, task.workspace.ttl_sec);
        gc.mark_active(&task.run_id);
        running.store(1, Ordering::Relaxed);
        let outcome = execute_task(args, &client, &task, &cache, &mut cancel).await;
        running.store(0, Ordering::Relaxed);
        gc.unmark_active(&task.run_id);
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

/// journal 里存的 status 字符串还原回 TaskStatus（未知值按 failed 处理）。
fn status_from_str(s: &str) -> TaskStatus {
    match s {
        "succeeded" => TaskStatus::Succeeded,
        "canceled" => TaskStatus::Canceled,
        _ => TaskStatus::Failed,
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
            artifacts: Vec::new(),
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

/// M2 能力上报：探测本机工具。git（checkout 需要）、tar（M3 缓存需要）；
/// 探测不到的就不上报，宿主据此过滤需要 checkout / 缓存的任务。
fn detect_tools() -> Vec<String> {
    let mut tools = vec![];
    if workspace::git_available() {
        tools.push("git".to_string());
    }
    if cache::tar_available() {
        tools.push("tar".to_string());
    }
    tools
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
    let tools = detect_tools();
    if !tools.is_empty() {
        log(&format!("tools available: {tools:?}"));
    }
    let req = RegisterRequest {
        runner_id: args.runner_id.clone(),
        labels,
        version: env!("CARGO_PKG_VERSION").to_string(),
        capacity: args.capacity,
        join_token: args.join_token.clone(),
        tools,
        protocol: Some(RUNNER_PROTOCOL),
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
                // M5 握手的另一半：宿主说它最低要什么版本，比本机高就别硬跑——
                // 用旧规矩解释新任务，比连不上更难查。
                if let Some(min) = resp.min_protocol {
                    if min > RUNNER_PROTOCOL {
                        return Err(anyhow!(
                            "宿主要求 runner 协议 >= {min}，本 runner 只支持 {RUNNER_PROTOCOL}：请升级 dsh-cicd-runner"
                        ));
                    }
                }
                log(&format!(
                    "registered: protocol={} heartbeatSec={} offlineAfterSec={}",
                    resp.protocol.unwrap_or(RUNNER_PROTOCOL),
                    resp.heartbeat_sec,
                    resp.offline_after_sec
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
    stats: Option<RunnerStats>,
    cancel: &mut watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let mut backoff = Backoff::new();
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        let res = tokio::select! {
            r = client.heartbeat(stats.clone()) => r,
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

/// 后台周期心跳：注册成功后立刻发一次，之后按 heartbeat_sec 一轮；
/// 每轮都带当前在跑任务数与缓存计数，执行期间同样可见。
fn spawn_heartbeat(
    client: Client,
    cache: CacheRunner,
    running: Arc<AtomicU32>,
    mut cancel: watch::Receiver<bool>,
    heartbeat_sec: u64,
) -> AbortOnDrop {
    AbortOnDrop(tokio::spawn(async move {
        let period = Duration::from_secs(heartbeat_sec.max(1));
        loop {
            let stats = Some(cache.runner_stats(running.load(Ordering::Relaxed)));
            if let Err(e) = heartbeat_with_retry(&client, stats, &mut cancel).await {
                log(&format!("heartbeat aborted: {e:#}"));
            }
            tokio::select! {
                _ = tokio::time::sleep(period) => {}
                _ = wait_cancel(&mut cancel) => return,
            }
        }
    }))
}

/// 后台任务句柄：随所有者 drop 而 abort，主循环退出后不再残留心跳。
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
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

/// Execute a claimed task: prepare workspace, (M2) checkout source, run steps,
/// stream logs, complete.
pub async fn execute_task(
    args: &Args,
    client: &Client,
    task: &Task,
    cache: &CacheRunner,
    cancel: &mut watch::Receiver<bool>,
) -> RunOutcome {
    // M2：工作目录以本地 <workdir>/ws/<runId> 为准（tasks/ 前缀保留 M1 兼容）。
    let ws_root = workspace::resolve_ws_root(&args.workdir, task);
    let git_ok = workspace::git_available();

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

    // M3：任务体只带名字，值在跑第一个步骤（含 checkout）之前换一次；
    // 合并后的 env 是唯一来源，凭据只在这里出现，不落盘、不进日志。
    let mut env = task.env.clone();
    let mut creds = CredCache::new(&task.task_id);
    let mut creds_failed = false;

    if let Err(e) = creds
        .ensure(client, &task.secret_refs, &task.secret_env, &mut env)
        .await
    {
        // fail closed：拿不到凭据就一个步骤都不跑，绝不带着空 env 继续。
        log(&format!("step 阶段开始前的中止：{e}"));
        creds_failed = true;
        failed = Some((-1, e));
    } else if let Err(e) = prepare_workspace(&ws_root, task.workspace.clean).await {
        failed = Some((-1, format!("workspace setup failed: {e}")));
    } else if let Some(source) = &task.source {
        // M2 checkout：带 source 的任务先 clone 到工作目录，再跑 run 步骤。
        if source.source_type != "git" {
            failed = Some((
                -1,
                format!("unsupported source type \"{}\"", source.source_type),
            ));
        } else if !git_ok {
            failed = Some((
                -1,
                "git is not available on this runner; cannot checkout source".to_string(),
            ));
        } else {
            // clone 的目标目录已由 prepare_workspace 建好（clean 后为空目录，
            // git 允许 clone 进空目录）；命令在 ws 根的父目录下执行。
            let parent = ws_root
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| args.workdir.clone());
            for (i, cmd) in workspace::checkout_commands(source, &ws_root).into_iter().enumerate() {
                if *cancel.borrow() {
                    canceled = true;
                    break;
                }
                log(&format!("checkout cmd {i}: {cmd}"));
                let res = run_command(
                    &cmd,
                    &parent,
                    &env,
                    Duration::from_secs(workspace::CHECKOUT_TIMEOUT_SEC),
                    seq.clone(),
                    Some(line_tx.clone()),
                    step_cancel_rx.clone(),
                )
                .await;
                match res {
                    Ok(StepOutcome::Exited(code)) => {
                        last_exit = Some(code);
                        if code != 0 {
                            failed = Some((code, format!("checkout failed with exit code {code}")));
                            break;
                        }
                    }
                    Ok(StepOutcome::TimedOut) => {
                        failed = Some((
                            124,
                            format!("checkout timeout after {}s", workspace::CHECKOUT_TIMEOUT_SEC),
                        ));
                        break;
                    }
                    Ok(StepOutcome::Canceled) => {
                        canceled = true;
                        break;
                    }
                    Err(e) => {
                        failed = Some((-1, format!("checkout spawn error: {e}")));
                        break;
                    }
                }
            }
        }
    }

    // M3：checkout 之后、跑 run 步骤之前恢复缓存（fail-open，绝不改任务结论）。
    if failed.is_none() && !canceled {
        cache.restore(client, &args.runner_id, task, &ws_root).await;
    }

    for (idx, step) in task.steps.iter().enumerate() {
        if *cancel.borrow() {
            canceled = true;
            break;
        }
        match step.uses.as_str() {
            "run" => {
                if creds_failed {
                    break;
                }
                // 每一步开始前确认凭据还够新（余量不足 30s 就重换）。
                if let Err(e) = creds
                    .ensure(client, &task.secret_refs, &task.secret_env, &mut env)
                    .await
                {
                    log(&format!("step {idx} 前的中止：{e}"));
                    // 这里不用再置 creds_failed：紧接的 break 已经结束循环，没有下一轮会读它。
                    failed = Some((-1, e));
                    break;
                }
                let command = step.command.clone().unwrap_or_default();
                let step_cwd = ws_root.join(step.cwd.clone().unwrap_or_else(|| ".".to_string()));
                let timeout_sec = step.timeout_sec.unwrap_or(DEFAULT_STEP_TIMEOUT_SEC);

                log(&format!("step {idx} (timeout {timeout_sec}s): {command}"));
                let res = run_command(
                    &command,
                    &step_cwd,
                    &env,
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
            // M2：宿主会把 {"uses":"checkout"} 放在 steps[0]；真正的 checkout
            // 已在上方 source 阶段完成，这里只消费掉该步骤。
            "checkout" => {
                if task.source.is_none() {
                    failed = Some((
                        -1,
                        format!("step {idx}: checkout step without a source"),
                    ));
                    break;
                }
            }
            other => {
                failed = Some((-1, format!("step {idx}: unsupported step kind \"{other}\"")));
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

    // M3：只有成功才保存缓存（fail-open，失败不改任务结论）。
    if status == TaskStatus::Succeeded {
        cache.save(client, &args.runner_id, task, &ws_root).await;
    }

    // M4：步骤全部成功后回流制品；无命中/上传失败只记日志，判定归宿主。
    let artifacts = if status == TaskStatus::Succeeded {
        collect::collect(client, &args.runner_id, task, &ws_root, &args.workdir).await
    } else {
        Vec::new()
    };

    let req = CompleteRequest {
        runner_id: args.runner_id.clone(),
        task_id: task.task_id.clone(),
        status,
        exit_code,
        error,
        artifacts,
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
