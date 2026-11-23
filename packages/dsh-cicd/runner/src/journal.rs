//! On-disk crash-recovery journal (JSONL at `<workdir>/journal.log`).

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::util::iso_now;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    pub event: String,
    pub task_id: String,
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

pub struct Journal {
    path: PathBuf,
}

impl Journal {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, event: JournalEvent) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{}", serde_json::to_string(&event)?)?;
        f.flush()
    }

    pub fn append_claimed(&self, task_id: &str) -> io::Result<()> {
        self.append(JournalEvent {
            event: "claimed".into(),
            task_id: task_id.into(),
            ts: iso_now(),
            status: None,
            exit_code: None,
        })
    }

    pub fn append_finished(&self, task_id: &str, status: &str, exit_code: i64) -> io::Result<()> {
        self.append(JournalEvent {
            event: "finished".into(),
            task_id: task_id.into(),
            ts: iso_now(),
            status: Some(status.into()),
            exit_code: Some(exit_code),
        })
    }

    /// Task ids that have a `claimed` event but no `finished` event yet.
    /// These are the tasks whose completion must be re-sent after a crash.
    pub fn recover(&self) -> Vec<String> {
        let data = match fs::read_to_string(&self.path) {
            Ok(d) => d,
            Err(_) => return vec![],
        };
        let mut pending: Vec<String> = vec![];
        let mut finished: HashSet<String> = HashSet::new();
        for line in data.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let ev: JournalEvent = match serde_json::from_str(line) {
                Ok(e) => e,
                Err(_) => continue, // torn write from a crash: skip
            };
            match ev.event.as_str() {
                "claimed" => {
                    // A later claim of the same task supersedes an earlier finish.
                    finished.remove(&ev.task_id);
                    if !pending.contains(&ev.task_id) {
                        pending.push(ev.task_id);
                    }
                }
                "finished" => {
                    pending.retain(|t| t != &ev.task_id);
                    finished.insert(ev.task_id.clone());
                }
                _ => {}
            }
        }
        pending
    }

    /// M2 断电续跑强化：该任务最后一次事件是否是 finished。
    /// 是 → 重启后再 claim 到同 taskId 时不重跑，只补发 complete。
    /// （claimed 出现在 finished 之后则视为再次执行中，返回 None。）
    pub fn finished(&self, task_id: &str) -> Option<(String, i64)> {
        let data = fs::read_to_string(&self.path).ok()?;
        let mut out: Option<(String, i64)> = None;
        for line in data.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let ev: JournalEvent = match serde_json::from_str(line) {
                Ok(e) => e,
                Err(_) => continue, // torn write from a crash: skip
            };
            if ev.task_id != task_id {
                continue;
            }
            match ev.event.as_str() {
                "claimed" => out = None,
                "finished" => {
                    out = Some((ev.status.unwrap_or_default(), ev.exit_code.unwrap_or(-1)))
                }
                _ => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_journal(name: &str) -> Journal {
        // Temp directories are unavailable in some sandboxes (Windows reports
        // PermissionDenied for %TEMP% from inside test processes), so journal
        // fixtures live under the crate's own target dir instead.
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join("journal")
            .join(name);
        fs::create_dir_all(&dir).unwrap_or_else(|e| {
            panic!("create_dir_all({}) failed: {e:?}", dir.display())
        });
        let j = Journal::new(dir.join(format!("journal-{name}.log")));
        let _ = fs::remove_file(j.path());
        eprintln!("TMPDIR={}", dir.display());
        j
    }

    #[test]
    fn recover_reports_claimed_without_finished_only() {
        let j = tmp_journal("replay");
        j.append_claimed("t1").unwrap();
        j.append_finished("t1", "succeeded", 0).unwrap();
        j.append_claimed("t2").unwrap();
        j.append_claimed("t3").unwrap();
        j.append_finished("t3", "failed", 2).unwrap();
        j.append_claimed("t4").unwrap();

        assert_eq!(j.recover(), vec!["t2".to_string(), "t4".to_string()]);
    }

    #[test]
    fn recover_on_missing_file_and_reclaim_dedup() {
        let j = tmp_journal("missing");
        assert!(j.recover().is_empty());

        // duplicate claimed lines (e.g. manual replay) must not duplicate entries
        j.append_claimed("t1").unwrap();
        j.append_claimed("t1").unwrap();
        assert_eq!(j.recover(), vec!["t1".to_string()]);
    }

    #[test]
    fn finished_reports_last_status_and_respects_reclaim() {
        let j = tmp_journal("finished");
        assert!(j.finished("t1").is_none()); // 文件不存在/无记录
        j.append_claimed("t1").unwrap();
        assert!(j.finished("t1").is_none()); // 只 claimed 不算完成
        j.append_finished("t1", "succeeded", 0).unwrap();
        assert_eq!(j.finished("t1"), Some(("succeeded".into(), 0)));
        j.append_claimed("t1").unwrap(); // 重新领走：回到执行中
        assert!(j.finished("t1").is_none());
        j.append_finished("t1", "failed", 3).unwrap();
        assert_eq!(j.finished("t1"), Some(("failed".into(), 3)));
    }

    #[test]
    fn reclaim_after_finish_is_pending_again() {
        // Journal is append-only and ordered: a claim written after a finish
        // means the task is in flight again, so it must be replayed.
        let j = tmp_journal("late-finish");
        j.append_claimed("t9").unwrap();
        j.append_finished("t9", "failed", -1).unwrap();
        assert!(j.recover().is_empty());
        j.append_claimed("t9").unwrap(); // reclaimed later
        assert_eq!(j.recover(), vec!["t9".to_string()]);
    }
}
