//! M2 workspace 管理：任务工作目录解析、checkout 命令构造、TTL GC。
//!
//! 约定（与宿主侧冻结的契约）：
//! - 任务工作目录以 runner 本地的 `<workdir>/ws/<runId>` 为准；
//!   任务描述里的 workspace.root 只是相对提示。
//! - M1 兼容：root 以 "tasks/" 开头的仍然按 `<workdir>/<root>` 认，
//!   这样旧宿主下发的任务行为不变。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use crate::protocol::{Source, Task};

/// workspace.ttlSec 缺省值（宿主没给或给 0 时使用）。
pub const DEFAULT_TTL_SEC: u64 = 3600;

/// GC 扫描周期。
pub const GC_INTERVAL: Duration = Duration::from_secs(60);

/// checkout 步骤的默认超时（clone 可能较大，比普通步骤宽一些）。
pub const CHECKOUT_TIMEOUT_SEC: u64 = 600;

/// 解析任务的工作目录。
pub fn resolve_ws_root(workdir: &Path, task: &Task) -> PathBuf {
    let base = absolute_workdir(workdir);
    // 统一成正斜杠判断前缀，避免 Windows 反斜杠路径误判。
    let root = task.workspace.root.replace('\\', "/");
    if root.starts_with("tasks/") {
        // M1 兼容：tasks/<runId> 布局照旧。
        base.join(root)
    } else {
        // M2 默认：root 只是提示，本地一律用 ws/<runId>。
        base.join("ws").join(&task.run_id)
    }
}

/// --workdir 给的是相对路径时先按进程 cwd 补成绝对路径。
///
/// checkout 命令在 ws 的父目录下执行，相对的目标路径会被 git 相对到那个父
/// 目录（ws/run-1 变成 ws/ws/run-1）；绝对路径让 clone 落点与
/// prepare_workspace 建的目录始终是同一个。
fn absolute_workdir(workdir: &Path) -> PathBuf {
    if workdir.is_absolute() {
        return workdir.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(workdir))
        .unwrap_or_else(|_| workdir.to_path_buf())
}

/// 本机是否有可用的 git（能力上报与 checkout 前都要探测）。
pub fn git_available() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 构造 checkout 的 shell 命令序列（交给 exec::run_command 执行，
/// 这样 clone 输出也能按行进入日志流、享受超时与整树 kill）。
///
/// 策略：先按 ref 做浅 clone；宿主若同时给了 sha，再 checkout 到该提交
/// （sha 通常是 ref 解析出的头提交，浅克隆里对象已在本地，可直接 checkout）。
pub fn checkout_commands(source: &Source, dest: &Path) -> Vec<String> {
    let depth = source.depth.unwrap_or(1).max(1);
    let mut clone = format!("git clone --depth {depth}");
    if let Some(git_ref) = source.git_ref.as_deref() {
        if !git_ref.is_empty() {
            clone.push_str(&format!(" --branch {git_ref}"));
        }
    }
    clone.push_str(&format!(" -- \"{}\" \"{}\"", source.url, dest.display()));
    let mut cmds = vec![clone];
    if let Some(sha) = source.sha.as_deref() {
        if !sha.is_empty() {
            cmds.push(format!("git -C \"{}\" checkout {sha}", dest.display()));
        }
    }
    cmds
}

/// GC 共享状态：活跃 runId 集合 + 每个 run 目录的 TTL（秒）。
///
/// 活跃目录的判定选用 active set（任务执行前后由主循环标记）而不是
/// 目录内标记文件：kill -9 下标记文件同样会残留成"永远活跃"，
/// 而 active set 随进程消失，重启后目录自然按 TTL 过期回收。
#[derive(Clone, Default)]
pub struct GcState {
    inner: Arc<Mutex<GcInner>>,
}

#[derive(Default)]
struct GcInner {
    active: HashSet<String>,
    ttls: HashMap<String, u64>,
}

impl GcState {
    pub fn mark_active(&self, run_id: &str) {
        self.inner.lock().unwrap().active.insert(run_id.to_string());
    }

    pub fn unmark_active(&self, run_id: &str) {
        self.inner.lock().unwrap().active.remove(run_id);
    }

    pub fn set_ttl(&self, run_id: &str, ttl_sec: u64) {
        self.inner.lock().unwrap().ttls.insert(run_id.to_string(), ttl_sec);
    }
}

/// 纯函数：给定 ws/ 下每个 run 目录的 (目录名, mtime)，计算应删除的目录。
/// 规则：mtime 年龄 >= 该 run 的 TTL（缺省 DEFAULT_TTL_SEC）且不在活跃集合。
pub fn gc_plan(
    entries: &[(String, SystemTime)],
    state: &GcState,
    default_ttl: u64,
    now: SystemTime,
) -> Vec<String> {
    let inner = state.inner.lock().unwrap();
    let mut doomed = vec![];
    for (name, mtime) in entries {
        if inner.active.contains(name) {
            continue;
        }
        let ttl = inner
            .ttls
            .get(name)
            .copied()
            .filter(|t| *t > 0)
            .unwrap_or(default_ttl);
        match now.duration_since(*mtime) {
            Ok(age) if age >= Duration::from_secs(ttl) => doomed.push(name.clone()),
            _ => {}
        }
    }
    doomed
}

/// 后台 GC 循环：每 60s 扫一次 <workdir>/ws/，删除过期且不活跃的 run 目录。
/// 目录遍历用 std::fs（条目数很小，不值得起 blocking 池）。
pub async fn gc_loop(workdir: PathBuf, state: GcState) {
    loop {
        tokio::time::sleep(GC_INTERVAL).await;
        let ws = workdir.join("ws");
        let mut entries: Vec<(String, SystemTime)> = vec![];
        if let Ok(rd) = std::fs::read_dir(&ws) {
            for entry in rd.flatten() {
                if let Ok(md) = entry.metadata() {
                    if md.is_dir() {
                        if let Ok(mtime) = md.modified() {
                            entries.push((entry.file_name().to_string_lossy().into_owned(), mtime));
                        }
                    }
                }
            }
        }
        for name in gc_plan(&entries, &state, DEFAULT_TTL_SEC, SystemTime::now()) {
            match std::fs::remove_dir_all(ws.join(&name)) {
                Ok(()) => log(&format!("gc: removed expired workspace {name}")),
                Err(e) => log(&format!("gc: cannot remove {name}: {e}")),
            }
        }
    }
}

fn log(msg: &str) {
    eprintln!("[runner] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_from_root_run(root: &str, run_id: &str) -> Task {
        serde_json::from_str(&format!(
            r#"{{"taskId":"t","runId":"{run_id}","stepIndex":0,"stageId":"b","leaseSec":60,
                "workspace":{{"root":"{root}","clean":false,"ttlSec":3600}},"env":{{}},
                "steps":[],"logStream":{{}},"artifacts":[]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn resolve_prefers_local_ws_dir() {
        // root 只是提示：非 tasks/ 前缀一律落到 ws/<runId>。
        let t = task_from_root_run("whatever/hint", "run-42");
        let base = std::env::temp_dir();
        assert_eq!(resolve_ws_root(&base, &t), base.join("ws").join("run-42"));
    }

    #[test]
    fn resolve_absolutizes_relative_workdir() {
        // 相对 --workdir 必须先补成绝对路径：checkout 在 ws 的父目录下执行，
        // 相对目标会被 git 拼成 ws/ws/<runId>。
        let t = task_from_root_run("ws/run-42", "run-42");
        let root = resolve_ws_root(Path::new("rel-work"), &t);
        assert!(root.is_absolute(), "ws root must be absolute: {root:?}");
        assert!(root.ends_with(Path::new("rel-work").join("ws").join("run-42")), "{root:?}");
    }

    #[test]
    fn resolve_keeps_m1_tasks_layout() {
        // M1 兼容：tasks/ 前缀维持 <workdir>/<root>。
        let base = std::env::temp_dir();
        let t = task_from_root_run("tasks/run-9", "run-9");
        assert_eq!(resolve_ws_root(&base, &t), base.join("tasks").join("run-9"));
        // Windows 风格的反斜杠也按 tasks/ 认。
        // JSON 里反斜杠要转义一次：传给 format! 的是 tasks\\run-9，
        // 解析后 root = tasks\run-9（单个反斜杠）。
        let t = task_from_root_run("tasks\\\\run-9", "run-9");
        assert_eq!(resolve_ws_root(&base, &t), base.join("tasks").join("run-9"));
    }

    #[test]
    fn checkout_commands_shape() {
        let src: Source = serde_json::from_str(
            r#"{"type":"git","url":"file:///repo","ref":"main","sha":"abc123","depth":1}"#,
        )
        .unwrap();
        let cmds = checkout_commands(&src, Path::new("/w/ws/run-1"));
        assert_eq!(cmds.len(), 2);
        assert!(cmds[0].starts_with("git clone --depth 1 --branch main -- "), "{cmds:?}");
        assert!(cmds[0].contains("file:///repo"), "{cmds:?}");
        assert!(cmds[1].starts_with("git -C \"/w/ws/run-1\" checkout abc123"), "{cmds:?}");

        // 无 ref / 无 sha 时只有一条裸 clone。
        let src: Source = serde_json::from_str(r#"{"type":"git","url":"file:///repo"}"#).unwrap();
        let cmds = checkout_commands(&src, Path::new("/w/ws/run-2"));
        assert_eq!(cmds, vec!["git clone --depth 1 -- \"file:///repo\" \"/w/ws/run-2\"".to_string()]);
    }

    #[test]
    fn gc_plan_removes_only_expired_and_inactive() {
        let state = GcState::default();
        state.set_ttl("ttl10", 10);
        state.mark_active("active");

        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let entries = vec![
            ("ttl10".to_string(), now - Duration::from_secs(9)),   // 未到 10s TTL
            ("ttl10-old".to_string(), now - Duration::from_secs(11)), // 名字不同、无 TTL → 缺省 3600，未过期
            ("default-old".to_string(), now - Duration::from_secs(3601)), // 缺省 TTL 已过
            ("active".to_string(), now - Duration::from_secs(9999)),     // 活跃，永不在运行中删
        ];
        let doomed = gc_plan(&entries, &state, DEFAULT_TTL_SEC, now);
        assert_eq!(doomed, vec!["default-old".to_string()]);

        state.set_ttl("ttl10-old", 10); // 登记过 TTL 的目录按自己的 TTL 算
        let mut doomed = gc_plan(&entries, &state, DEFAULT_TTL_SEC, now);
        doomed.sort();
        assert_eq!(doomed, vec!["default-old".to_string(), "ttl10-old".to_string()]);

        state.unmark_active("active");
        let mut doomed = gc_plan(&entries, &state, DEFAULT_TTL_SEC, now);
        doomed.sort();
        assert!(doomed.contains(&"active".to_string()));
    }
}
