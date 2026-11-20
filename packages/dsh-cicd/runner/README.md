# dsh-cicd-runner

Remote build runner for [dsh-cicd](../README.md). It implements the client side of
**Runner Protocol v2**: register, long-poll for a task, execute its steps locally,
stream the output back in sequenced batches, and report the final status.

M1 scope: one runner process, one task at a time, single-step (`uses: run`) tasks.

## Build

```sh
cd packages/dsh-cicd/runner
cargo build --release
```

The binary lands in `target/release/dsh-cicd-runner` (`dsh-cicd-runner.exe` on Windows).
Requires Rust 1.75+ and a working linker for the host target. There are **no C
dependencies** - the HTTP client is built with `reqwest` `default-features = false`
and only the `json` feature, so the whole crate is pure Rust.

## Usage

```sh
dsh-cicd-runner \
  --server http://cicd.internal.example.com \   # M1: plain HTTP only (see limitations)
  --runner build-01 \
  --join-token jt_xxxxxxxx \
  --labels linux,fast \
  --capacity 2 \
  --workdir ./runner-work
```

Run one task and exit (handy for tests and one-shot CI jobs):

```sh
dsh-cicd-runner --server http://127.0.0.1:8787 --runner r1 --join-token jt_test --once
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--server` | (required) | Base URL of the dsh-cicd server, e.g. `https://cicd.example.com` |
| `--runner` | (required) | Runner id to register as |
| `--join-token` | (required) | Join token issued by the server |
| `--labels` | `""` | Comma-separated capability labels, e.g. `linux,docker` |
| `--capacity` | `1` | Advertised parallel slots (M1 uses one) |
| `--workdir` | `./runner-work` | Where task workspaces, `credentials.json` and `journal.log` live |
| `--insecure` | off | Accepted for compatibility; this build speaks plain HTTP only (see limits) |
| `--once` | off | Claim one task, run it, exit |
| `--version` | - | Print the version |

All human-readable output goes to **stderr**; nothing is written to stdout.

## Protocol endpoints

Base: `<server>/api/plugins/cicd/runner/v2`. Every endpoint except `/register`
requires `Authorization: Bearer <runnerToken>`.

| Endpoint | Request | Success | Errors |
| --- | --- | --- | --- |
| `POST /register` | `{"runnerId","labels","version","capacity","joinToken"}` | `{"ok":true,"runnerId","runnerToken","heartbeatSec","offlineAfterSec","serverTime"}` | 401 `RUNNER_JOIN_TOKEN_INVALID` / `RUNNER_JOIN_TOKEN_UNSET`, 403 `RUNNER_REVOKED` |
| `POST /heartbeat` | `{"runnerId"}` | `{"ok":true,"lastSeenAt"}` | 401 `RUNNER_TOKEN_INVALID` / `RUNNER_UNREGISTERED`, 403 `RUNNER_REVOKED` |
| `POST /claim` | `{"runnerId","waitMs":25000}` | `{"ok":true,"task":{...}}` or `{"ok":true,"task":null}` | 401 / 403 as above |
| `POST /logs` | `{"runnerId","taskId","lines":[{"seq","text"}]}` | `{"ok":true,"accepted":N,"dropped":M}` | unknown task: 200 `{"ok":true,"accepted":0,"dropped":N,"code":"TASK_UNKNOWN"}` |
| `POST /complete` | `{"runnerId","taskId","status","exitCode","error"}` | `{"ok":true}` | unknown task: 200 `{"ok":true,"code":"TASK_UNKNOWN"}` |

`status` is one of `succeeded`, `failed`, `canceled`. Error bodies are
`{"ok":false,"code":"<CODE>","error":"<message>"}`.

### Task shape (M1)

```json
{
  "taskId": "t-abc", "runId": "run-9", "stepIndex": 0, "stageId": "build",
  "leaseSec": 600,
  "workspace": {"root": "tasks/run-9", "clean": true, "ttlSec": 3600},
  "env": {"CI": "1"},
  "steps": [{"uses": "run", "command": "echo hi", "cwd": ".", "timeoutSec": 60}],
  "logStream": {"batchMs": 250},
  "artifacts": []
}
```

`workspace.root` is relative to `--workdir`.

## Execution semantics

- **Workspace**: `<workdir>/<workspace.root>`; `clean: true` wipes it first.
- **Steps**: sequential. `uses: "run"` executes `command` through `cmd /C` on
  Windows and `sh -c` elsewhere, with `cwd` relative to the workspace root and the
  parent environment overridden by each entry of `env`. Any other `uses` value
  fails that step with `step N: unsupported step kind "<kind>"`.
- **Logs**: stdout and stderr are merged line by line and share one monotonically
  increasing `seq` starting at 1. Batches are flushed every `logStream.batchMs`
  (250 ms fallback) and always flushed before `/complete`.
- **Timeouts**: `timeoutSec` (default 600) kills the process tree and reports
  `failed`, exit code 124, error `step timeout after Ns`.
- **Exit status**: all steps succeeded -> `succeeded` with the last step's exit code;
  otherwise `failed` with the failing step's code and an error naming the step.
  SIGINT/SIGTERM stops the running step and reports `canceled`.
- **Retries**: `register`/`claim` use exponential backoff (1 s doubling, capped at
  30 s); a 401 on register or any 403 is fatal and exits the process. Log batches get
  3 attempts and are then dropped (the server deduplicates by `(taskId, seq)`).
  `/complete` retries until it succeeds or the process is interrupted.

## Journal and credentials

`<workdir>/journal.log` is append-only JSONL:

```json
{"event":"claimed","taskId":"t-abc","ts":"2026-11-21T02:00:00.000Z"}
{"event":"finished","taskId":"t-abc","status":"succeeded","exitCode":0,"ts":"2026-11-21T02:00:03.120Z"}
```

On startup the runner replays the journal: any task with a `claimed` line and no
subsequent `finished` line is reported as `failed` (exit code -1, error
`runner crashed before reporting completion`) so the server does not wait for the
lease to expire.

`<workdir>/credentials.json` stores the last issued token per runner id
(`0600` on Unix). The token is otherwise kept in memory only; it is never printed.

## M1 limitations

- **No credential exchange**: the join token is sent on every start; there is no
  refresh/rotation flow beyond whatever `/register` returns.
- **No cache and no artifacts**: cache keys are not implemented and `artifacts`
  must be empty; nothing is uploaded.
- **Single-step tasks**: only steps of kind `run` are executed; parallel jobs,
  matrices and stage DAGs belong to later milestones.
- **Plain HTTP only**: the HTTP client is compiled without a TLS feature, so
  `https` endpoints fail to connect and `--insecure` is accepted but has no effect.
  This is a build-environment workaround; re-enabling a rustls feature restores TLS.
- **One task at a time**: `--capacity` is advertised to the server but only one
  claim is processed concurrently.
