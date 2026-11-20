//! Local command execution with line-oriented stdout/stderr capture and timeouts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;

use crate::seq::SeqAlloc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedLine {
    pub seq: u64,
    pub text: String,
    pub stream: StreamKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    Exited(i64),
    TimedOut,
    Canceled,
}

/// Byte-stream -> logical line reader, shared by both stdout and stderr.
pub struct LineReader {
    buf: Vec<u8>,
}

impl LineReader {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(data);
        let mut out = vec![];
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }

    pub fn flush(&mut self) -> Vec<String> {
        if self.buf.is_empty() {
            return vec![];
        }
        let mut line: Vec<u8> = std::mem::take(&mut self.buf);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        vec![String::from_utf8_lossy(&line).into_owned()]
    }
}

impl Default for LineReader {
    fn default() -> Self {
        Self::new()
    }
}

async fn pump<R: AsyncRead + Unpin>(
    mut r: R,
    kind: StreamKind,
    seq: std::sync::Arc<std::sync::Mutex<SeqAlloc>>,
    tx: Option<UnboundedSender<EmittedLine>>,
) {
    let mut reader = BufReader::new(&mut r);
    let mut buf = [0u8; 8192];
    let mut lines = LineReader::new();
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        for text in lines.push(&buf[..n]) {
            let seq = seq.lock().unwrap().next();
            if let Some(tx) = &tx {
                let _ = tx.send(EmittedLine { seq, text, stream: kind });
            }
        }
    }
    for text in lines.flush() {
        let seq = seq.lock().unwrap().next();
        if let Some(tx) = &tx {
            let _ = tx.send(EmittedLine { seq, text, stream: kind });
        }
    }
}

fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    let _ = child.start_kill();
}

/// Run one shell command. `cancel` resolving means: kill the whole tree.
pub async fn run_command(
    command: &str,
    cwd: &PathBuf,
    env_overrides: &HashMap<String, String>,
    timeout: Duration,
    seq: std::sync::Arc<std::sync::Mutex<SeqAlloc>>,
    tx: Option<UnboundedSender<EmittedLine>>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<StepOutcome> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env_overrides {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("failed to spawn shell for command: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let mut handles = vec![];
    if let Some(out) = stdout {
        handles.push(tokio::spawn(pump(out, StreamKind::Stdout, seq.clone(), tx.clone())));
    }
    if let Some(err) = stderr {
        handles.push(tokio::spawn(pump(err, StreamKind::Stderr, seq.clone(), tx.clone())));
    }

    let mut cancel_rx = cancel;
    let outcome = tokio::select! {
        biased;
        _ = wait_cancel(&mut cancel_rx) => {
            kill_tree(&mut child);
            let _ = child.start_kill();
            let _ = child.wait().await;
            StepOutcome::Canceled
        }
        _ = tokio::time::sleep(timeout) => {
            kill_tree(&mut child);
            let _ = child.start_kill();
            let _ = child.wait().await;
            StepOutcome::TimedOut
        }
        status = child.wait() => {
            match status {
                Ok(s) => StepOutcome::Exited(s.code().map(|c| c as i64).unwrap_or(-1)),
                Err(_) => StepOutcome::Exited(-1),
            }
        }
    };

    // Drain the pipes before returning so the last lines still get a seq.
    for h in handles {
        let _ = h.await;
    }
    Ok(outcome)
}

async fn wait_cancel(rx: &mut tokio::sync::watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    loop {
        if rx.changed().await.is_err() {
            // sender dropped: never cancelled
            std::future::pending::<()>().await;
        }
        if *rx.borrow() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_reader_splits_and_keeps_partial() {
        let mut r = LineReader::new();
        assert_eq!(r.push(b"hello\r\nwor"), vec!["hello".to_string()]);
        assert_eq!(r.push(b"ld\n\n"), vec!["world".to_string(), "".to_string()]);
        assert!(r.push(b"tail-no-newline").is_empty());
        assert_eq!(r.flush(), vec!["tail-no-newline".to_string()]);
        assert!(r.flush().is_empty());
    }

    #[tokio::test]
    async fn run_echo_captures_line() {
        let seq = std::sync::Arc::new(std::sync::Mutex::new(SeqAlloc::new(1)));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let workdir = std::env::temp_dir();
        let outcome = run_command(
            "echo hi",
            &workdir,
            &HashMap::new(),
            Duration::from_secs(30),
            seq,
            Some(tx),
            cancel_rx,
        )
        .await
        .unwrap();
        assert_eq!(outcome, StepOutcome::Exited(0));
        let first = rx.try_recv().expect("one line");
        assert_eq!(first.seq, 1);
        assert_eq!(first.text, "hi");
    }
}
