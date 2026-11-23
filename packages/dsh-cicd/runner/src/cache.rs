//! M3 缓存层：按任务声明从宿主拉/推 tar.gz 字节（fail-open）。
//!
//! 缓存只是加速层：任何一步失败都只记一行日志与 miss，绝不改变任务结论。
//! 压缩/解包用系统 tar（bsdtar），不引入 cargo 依赖。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::client::Client;
use crate::protocol::{CacheLookupRequest, CacheStats, RunnerStats, Task};

/// 压缩/解包子进程的超时。
pub const TAR_TIMEOUT: Duration = Duration::from_secs(300);

fn log(msg: &str) {
    eprintln!("[runner] {msg}");
}

/// 系统 tar 是否可用（同步探测一次，结果缓存）。
pub fn tar_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("tar")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// 命中/未命中/保存计数：执行线程写，心跳线程读。
#[derive(Clone, Default)]
pub struct CacheRunner {
    counters: Arc<Counters>,
    /// 压缩包落盘目录：<workdir>/cache/（不放 ws/ 里，workspace 清理删不到在途包）。
    dir: PathBuf,
}

#[derive(Default)]
struct Counters {
    hits: AtomicU64,
    misses: AtomicU64,
    saves: AtomicU64,
}

impl CacheRunner {
    pub fn new(workdir: impl AsRef<Path>) -> Self {
        Self {
            counters: Arc::new(Counters::default()),
            dir: workdir.as_ref().join("cache"),
        }
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.counters.hits.load(Ordering::Relaxed),
            misses: self.counters.misses.load(Ordering::Relaxed),
            saves: self.counters.saves.load(Ordering::Relaxed),
        }
    }

    /// 心跳负载：running 由调用方给（串行 runner 执行中 1、空闲 0），diskFreePct 不编。
    pub fn runner_stats(&self, running: u32) -> RunnerStats {
        RunnerStats {
            running: Some(running),
            disk_free_pct: None,
            cache: Some(self.stats()),
        }
    }

    /// 恢复：只处理 mode ∈ {restore, both}。任何失败只记 miss 与一行日志。
    pub async fn restore(&self, client: &Client, runner_id: &str, task: &Task, ws_root: &Path) {
        for decl in &task.cache {
            if !restores(&decl.mode) {
                continue;
            }
            if !tar_available() {
                self.counters.misses.fetch_add(1, Ordering::Relaxed);
                log(&format!("cache {}: tar 不可用，跳过恢复", decl.key));
                continue;
            }
            let req = CacheLookupRequest {
                runner_id: runner_id.to_string(),
                task_id: task.task_id.clone(),
                key: decl.key.clone(),
                restore_keys: decl.restore_keys.clone(),
            };
            let resp = match client.cache_lookup(&req).await {
                Ok(r) => r,
                Err(e) => {
                    self.counters.misses.fetch_add(1, Ordering::Relaxed);
                    log(&format!("cache {}: 查询失败（miss）: {e}", decl.key));
                    continue;
                }
            };
            if !resp.hit || resp.digest.is_empty() {
                self.counters.misses.fetch_add(1, Ordering::Relaxed);
                log(&format!("cache {}: 未命中", decl.key));
                continue;
            }
            let archive = self.dir.join(format!("{}.tar.gz", sanitize(&resp.digest)));
            let res = self
                .download_and_unpack(client, runner_id, &task.task_id, &resp.digest, &archive, ws_root)
                .await;
            let _ = std::fs::remove_file(&archive);
            match res {
                Ok(()) => {
                    self.counters.hits.fetch_add(1, Ordering::Relaxed);
                    log(&format!("cache {}: 命中 {} 并已解包", decl.key, resp.key));
                }
                Err(e) => {
                    self.counters.misses.fetch_add(1, Ordering::Relaxed);
                    log(&format!("cache {}: 恢复失败（miss）: {e}", decl.key));
                }
            }
        }
    }

    /// 保存：只处理 mode ∈ {save, both}，只打包已存在的 paths；失败只记日志。
    pub async fn save(&self, client: &Client, runner_id: &str, task: &Task, ws_root: &Path) {
        for decl in &task.cache {
            if !saves(&decl.mode) {
                continue;
            }
            let paths: Vec<String> = decl
                .paths
                .iter()
                .filter(|p| ws_root.join(p.as_str()).exists())
                .cloned()
                .collect();
            if paths.is_empty() {
                log(&format!("cache {}: 声明的 paths 都不存在，跳过保存", decl.key));
                continue;
            }
            if !tar_available() {
                log(&format!("cache {}: tar 不可用，跳过保存", decl.key));
                continue;
            }
            let archive = self.dir.join(format!("save-{}.tar.gz", sanitize(&decl.key)));
            let res = self
                .pack_and_upload(client, runner_id, &task.task_id, &decl.key, &archive, ws_root, &paths)
                .await;
            let _ = std::fs::remove_file(&archive);
            match res {
                Ok(()) => {
                    self.counters.saves.fetch_add(1, Ordering::Relaxed);
                    log(&format!("cache {}: 已保存", decl.key));
                }
                Err(e) => log(&format!("cache {}: 保存失败: {e}", decl.key)),
            }
        }
    }

    fn ensure_dir(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("创建 {:?} 失败: {e}", self.dir))
    }

    async fn download_and_unpack(
        &self,
        client: &Client,
        runner_id: &str,
        task_id: &str,
        digest: &str,
        archive: &Path,
        ws_root: &Path,
    ) -> Result<(), String> {
        self.ensure_dir()?;
        let bytes = client
            .cache_download(runner_id, task_id, digest)
            .await
            .map_err(|e| format!("下载失败: {e}"))?;
        tokio::fs::write(archive, &bytes)
            .await
            .map_err(|e| format!("写入 {archive:?} 失败: {e}"))?;
        run_tar(&[
            "-xzf".to_string(),
            archive_arg(archive)?,
            "-C".to_string(),
            archive_arg(ws_root)?,
        ])
        .await
    }

    async fn pack_and_upload(
        &self,
        client: &Client,
        runner_id: &str,
        task_id: &str,
        key: &str,
        archive: &Path,
        ws_root: &Path,
        paths: &[String],
    ) -> Result<(), String> {
        self.ensure_dir()?;
        let mut args = vec![
            "-czf".to_string(),
            archive_arg(archive)?,
            "-C".to_string(),
            archive_arg(ws_root)?,
        ];
        args.extend(paths.iter().cloned());
        run_tar(&args).await?;
        let bytes = tokio::fs::read(archive)
            .await
            .map_err(|e| format!("读取 {archive:?} 失败: {e}"))?;
        client
            .cache_upload(runner_id, task_id, key, bytes)
            .await
            .map_err(|e| format!("上传失败: {e}"))?;
        Ok(())
    }
}

fn restores(mode: &str) -> bool {
    mode == "restore" || mode == "both"
}

fn saves(mode: &str) -> bool {
    mode == "save" || mode == "both"
}

/// 文件名里只留安全字符（digest 的 "sha256:" 在 Windows 上不能进文件名）。
pub(crate) fn sanitize(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    if out.len() > 80 {
        out.truncate(80);
    }
    if out.is_empty() {
        out.push_str("blob");
    }
    out
}

pub(crate) fn archive_arg(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("路径不是合法 UTF-8: {path:?}"))
}

/// 跑一次 tar，超时按失败处理（kill_on_drop 保证子进程一起死）。
pub(crate) async fn run_tar(args: &[String]) -> Result<(), String> {
    let child = tokio::process::Command::new("tar")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("tar 启动失败: {e}"))?;
    match tokio::time::timeout(TAR_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(format!(
            "tar 退出 {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Ok(Err(e)) => Err(format!("tar 执行失败: {e}")),
        Err(_) => Err(format!("tar 超时（{}s）", TAR_TIMEOUT.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_select_the_right_phase() {
        assert!(restores("restore"));
        assert!(restores("both"));
        assert!(!restores("save"));
        assert!(saves("save"));
        assert!(saves("both"));
        assert!(!saves("restore"));
    }

    #[test]
    fn sanitize_keeps_names_filename_safe() {
        assert_eq!(sanitize("sha256:ab/cd"), "sha256_ab_cd");
        assert_eq!(sanitize("npm-abc_1.2"), "npm-abc_1.2");
        assert_eq!(sanitize(""), "blob");
        assert!(sanitize(&"x".repeat(200)).len() <= 80);
    }

    #[test]
    fn runner_stats_reports_running_and_counters() {
        let cache = CacheRunner::new(std::env::temp_dir().join("cache-runner-stats"));
        cache.counters.hits.fetch_add(2, Ordering::Relaxed);
        cache.counters.misses.fetch_add(3, Ordering::Relaxed);
        let stats = cache.runner_stats(1);
        assert_eq!(stats.running, Some(1));
        assert!(stats.disk_free_pct.is_none());
        let c = stats.cache.expect("cache stats");
        assert_eq!((c.hits, c.misses, c.saves), (2, 3, 0));
    }
}
