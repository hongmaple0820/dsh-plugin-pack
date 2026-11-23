//! M4：制品回流。run 步骤全部成功后，按 task.artifacts 在 workspace 里 glob 命中
//! 文件、打 tar.gz、逐名 PUT 回宿主，complete 时带清单。
//!
//! 与缓存层同一定位：尽力而为。单个制品没命中或上传失败只记一行日志，
//! 「声明必须到齐」的判定归宿主（ARTIFACT_MISSING）。

use std::path::{Path, PathBuf};

use crate::cache;
use crate::client::Client;
use crate::protocol::{ArtifactReport, Task};

fn log(msg: &str) {
    eprintln!("[runner] {msg}");
}

/// 收集并上传全部声明的制品，返回写进 complete 的清单。
pub async fn collect(
    client: &Client,
    runner_id: &str,
    task: &Task,
    ws_root: &Path,
    workdir: &Path,
) -> Vec<ArtifactReport> {
    let mut reports = Vec::new();
    if task.artifacts.is_empty() {
        return reports;
    }
    // 打包文件放 <workdir>/cache/，不落进 workspace。
    let dir = workdir.join("cache");
    for decl in &task.artifacts {
        let files = glob_files(ws_root, &decl.paths);
        if files.is_empty() {
            // optional 无命中静默；非 optional 记一行，判定交宿主。
            if !decl.optional {
                log(&format!("制品 {} 未命中（{:?}），跳过", decl.name, decl.paths));
            }
            continue;
        }
        if !cache::tar_available() {
            log(&format!("制品 {} 跳过：系统没有可用的 tar", decl.name));
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log(&format!("制品 {} 跳过：建目录 {dir:?} 失败: {e}", decl.name));
            continue;
        }
        let archive = dir.join(format!(
            "art-{}-{}.tar.gz",
            cache::sanitize(&decl.name),
            std::process::id()
        ));
        let result =
            pack_and_upload(client, runner_id, task, &decl.name, ws_root, &archive, &files).await;
        let _ = std::fs::remove_file(&archive);
        match result {
            Ok(report) => {
                log(&format!("制品 {} 已回流 {} 字节", report.name, report.bytes));
                reports.push(report);
            }
            Err(e) => log(&format!("制品 {} 回流失败: {e}", decl.name)),
        }
    }
    reports
}

async fn pack_and_upload(
    client: &Client,
    runner_id: &str,
    task: &Task,
    name: &str,
    ws_root: &Path,
    archive: &Path,
    files: &[String],
) -> Result<ArtifactReport, String> {
    // 与 cache::save 同风格：在 workspace 根下按相对路径打包。
    let mut args = vec![
        "-czf".to_string(),
        cache::archive_arg(archive)?,
        "-C".to_string(),
        cache::archive_arg(ws_root)?,
        "--".to_string(),
    ];
    args.extend(files.iter().cloned());
    cache::run_tar(&args).await?;

    let bytes = tokio::fs::read(archive)
        .await
        .map_err(|e| format!("读取 {archive:?} 失败: {e}"))?;
    let resp = client
        .artifact_upload(runner_id, &task.task_id, name, bytes)
        .await
        .map_err(|e| format!("上传失败: {e}"))?;
    Ok(ArtifactReport {
        name: name.to_string(),
        digest: resp.digest,
        bytes: resp.bytes,
    })
}

/// 在 workspace 根下按声明 glob 找文件，返回 '/'-分隔的相对路径（已排序去重）。
pub fn glob_files(ws_root: &Path, patterns: &[String]) -> Vec<String> {
    let pats: Vec<Pattern> = patterns
        .iter()
        .map(|p| normalize_pattern(p))
        .filter(|p| !p.segs.is_empty())
        .collect();
    if pats.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    walk(ws_root, "", &mut out);
    out.retain(|rel| {
        let segs: Vec<&str> = rel.split('/').collect();
        pats.iter().any(|p| match_pattern(p, &segs))
    });
    out.sort();
    out.dedup();
    out
}

/// 一条声明路径：'/'-分隔的相对段（反斜杠分隔也接受）。
struct Pattern {
    segs: Vec<String>,
    /// 没有通配符的字面路径：写成目录时也要覆盖其下所有文件。
    literal: bool,
}

fn normalize_pattern(p: &str) -> Pattern {
    let segs: Vec<String> = p
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(|s| s.to_string())
        .collect();
    let literal = !segs.iter().any(|s| s.contains('*') || s.contains('?'));
    Pattern { segs, literal }
}

fn match_pattern(p: &Pattern, path: &[&str]) -> bool {
    if match_segments(&p.segs, path) {
        return true;
    }
    // 字面目录：dist 覆盖 dist/a.txt。
    p.literal
        && path.len() > p.segs.len()
        && p.segs.iter().zip(path.iter()).all(|(a, b)| a == b)
}

fn walk(root: &Path, prefix: &str, out: &mut Vec<String>) {
    let dir: PathBuf = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        root.join(prefix)
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // .git 永远不属于制品。
        if name == ".git" {
            continue;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk(root, &rel, out),
            Ok(ft) if ft.is_file() => out.push(rel),
            _ => {}
        }
    }
}

/// 逐段匹配；双星号吃掉任意多级目录。
fn match_segments(pat: &[String], path: &[&str]) -> bool {
    let Some((head, rest)) = pat.split_first() else {
        return path.is_empty();
    };
    if head == "**" {
        return (0..=path.len()).any(|i| match_segments(rest, &path[i..]));
    }
    match path.split_first() {
        Some((name, tail)) => match_segment(head, name) && match_segments(rest, tail),
        None => false,
    }
}

/// 单段通配：星号任意长度、问号单个字符。
fn match_segment(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            pi += 1;
            mark = ni;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pat(p: &str) -> Pattern {
        normalize_pattern(p)
    }

    #[test]
    fn double_star_matches_any_depth() {
        assert!(match_pattern(&pat("dist/**"), &["dist", "a.js"]));
        assert!(match_pattern(&pat("dist/**"), &["dist", "x", "y.js"]));
        assert!(!match_pattern(&pat("dist/**"), &["src", "a.js"]));
        assert!(match_pattern(&pat("**/*.map"), &["a.map"]));
        assert!(match_pattern(&pat("**/*.map"), &["dist", "a.map"]));
        assert!(!match_pattern(&pat("**/*.map"), &["dist", "a.js"]));
    }

    #[test]
    fn literal_directory_covers_its_files() {
        assert!(match_pattern(&pat("dist"), &["dist", "a.js"]));
        assert!(match_pattern(&pat("dist"), &["dist", "x", "y.js"]));
        assert!(match_pattern(&pat("dist"), &["dist"]));
        assert!(!match_pattern(&pat("dist"), &["disty", "a.js"]));
        assert!(match_pattern(&pat("dist/a.txt"), &["dist", "a.txt"]));
    }

    #[test]
    fn wildcards_match_within_one_segment() {
        assert!(match_segment("a?c", "abc"));
        assert!(!match_segment("a?c", "ac"));
        assert!(match_segment("*.txt", "out.txt"));
        assert!(!match_segment("*.txt", "out.md"));
        assert!(match_segment("out*", "out"));
    }

    #[test]
    fn patterns_are_normalized_to_relative_segments() {
        assert_eq!(pat("dist/").segs, vec!["dist"]);
        assert_eq!(pat("./dist/b.js").segs, vec!["dist", "b.js"]);
        assert_eq!(pat("dist\\b.js").segs, vec!["dist", "b.js"]);
    }
}
