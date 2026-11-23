# dsh-cicd-runner

Remote build runner for [dsh-cicd](../README.md). It implements the client side of
**Runner Protocol v2**: register, long-poll for a task, execute its steps locally,
stream the output back in sequenced batches, and report the final status.

M2 scope: one runner process, one task at a time. Every task gets an isolated
workspace under `<workdir>/ws/`, a `checkout` step clones the run's git source
before any `run` step runs, idle workspaces are garbage-collected on a TTL, and a
crash-recovery journal makes sure a step that already finished is never executed
twice (for example after a `kill -9` and restart).

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
  --server http://cicd.internal.example.com \   # plain HTTP only (see limitations)
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
| `--capacity` | `1` | Advertised parallel slots (this build keeps one claim in flight) |
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
| `POST /register` | `{"runnerId","labels","version","capacity","joinToken","tools","protocol":2}` (`protocol` optional) | `{"ok":true,"runnerId","runnerToken","heartbeatSec","offlineAfterSec","serverTime","protocol","minProtocol"}` | 401 `RUNNER_JOIN_TOKEN_INVALID` / `RUNNER_JOIN_TOKEN_UNSET`, 403 `RUNNER_REVOKED`, 426 `RUNNER_PROTOCOL_UNSUPPORTED` (the body claims a protocol other than 2; the runner is not registered) |
| `POST /heartbeat` | `{"runnerId","stats":{"running","diskFreePct","cache":{"hits","misses","saves"}}}` (`stats` optional; a malformed one is ignored) | `{"ok":true,"lastSeenAt","stats"}` | 401 `RUNNER_TOKEN_INVALID` / `RUNNER_UNREGISTERED`, 403 `RUNNER_REVOKED` |
| `POST /claim` | `{"runnerId","waitMs":25000}` | `{"ok":true,"task":{...}}` or `{"ok":true,"task":null}` | 401 / 403 as above |
| `POST /logs` | `{"runnerId","taskId","lines":[{"seq","text"}]}` | `{"ok":true,"accepted":N,"dropped":M}` | unknown task: 200 `{"ok":true,"accepted":0,"dropped":N,"code":"TASK_UNKNOWN"}` |
| `POST /complete` | `{"runnerId","taskId","status","exitCode","error","artifacts":[{"name","digest","bytes"}]}` | `{"ok":true,"missing":[]}`; a missing non-optional artifact fails the task with `code:"ARTIFACT_MISSING"` | unknown task: 200 `{"ok":true,"code":"TASK_UNKNOWN"}` |
| `POST /credentials` | `{"runnerId","taskId","names":["DB_PASSWORD"]}` | `{"ok":true,"values":{"DB_PASSWORD":"…"},"missing":[],"expiresAt","ttlSec"}` | 400 `BAD_REQUEST`, 403 `SECRET_NOT_DECLARED` (a name the task never declared), 404 `TASK_UNKNOWN` |
| `POST /cache/lookup` | `{"runnerId","taskId","key","restoreKeys":["k-"]}` | `{"ok":true,"hit":true,"key","digest","bytes","paths"}` or `hit:false` | 403 `CACHE_NOT_DECLARED`, 404 `TASK_UNKNOWN`, 503 `CACHE_UNAVAILABLE` |
| `GET /cache/blob?runnerId=&taskId=&digest=` | – | raw tar.gz bytes (`application/octet-stream`, `x-cicd-cache-key`/`x-cicd-cache-digest` headers) | 403 `CACHE_NOT_DECLARED` (digest is not this project's cache pointer), 404 `TASK_UNKNOWN` |
| `PUT /cache/blob?runnerId=&taskId=&key=` | raw tar.gz body (≤ 256 MiB) | `{"ok":true,"key","digest","bytes","deduped"}` | 403 `CACHE_SAVE_FORBIDDEN` (`mode` without `save`), 413 `CACHE_TOO_LARGE`, 404 `TASK_UNKNOWN` |
| `PUT /artifacts/:taskId/:name?runnerId=` | raw tar.gz body (≤ 512 MiB) | `{"ok":true,"name","digest","bytes","deduped"}` | 400 `BAD_ARTIFACT_NAME`, 403 `ARTIFACT_NOT_DECLARED`, 404 `TASK_UNKNOWN`, 413 `ARTIFACT_TOO_LARGE`, 503 `CACHE_UNAVAILABLE` |

`status` is one of `succeeded`, `failed`, `canceled`. Error bodies are
`{"ok":false,"code":"<CODE>","error":"<message>"}`.

### Task shape (M4)

```json
{
  "taskId": "t-abc", "runId": "run-9", "stepIndex": 0, "stageId": "build",
  "leaseSec": 600,
  "workspace": {"root": "ws/run-9", "clean": true, "ttlSec": 3600},
  "env": {"CI": "1", "LOG_LEVEL": "info"},
  "projectId": "demo",
  "source": {"type": "git", "url": "https://git.example.com/demo.git", "ref": "main", "sha": "abc1234", "depth": 1},
  "secretRefs": ["DB_PASSWORD"],
  "secretEnv": [{"env": "DB_PASSWORD", "ref": "DB_PASSWORD"}],
  "cache": [{"key": "cargo-v3", "paths": ["target"], "restoreKeys": ["cargo-"], "mode": "both"}],
  "steps": [
    {"uses": "checkout", "cwd": ".", "timeoutSec": 600},
    {"uses": "run", "command": "cargo build --release --password ${DB_PASSWORD}", "cwd": ".", "timeoutSec": 600}
  ],
  "logStream": {"batchMs": 250},
  "artifacts": [{"name": "web-dist", "paths": ["dist/**"], "optional": false}]
}
```

`secretRefs`/`secretEnv`/`cache` are M3, `artifacts` is M4 (one entry per
stage-scoped `uses: collect` step; names and paths are validated server-side). The task never carries a secret value:
env entries and commands hold `${NAME}` placeholders, and the values are fetched
once over `/credentials` before the first step. `cache` entries are the project's
top-level `cache:` declaration, normalised server-side (`lib/pipe.js`).

`workspace.root` is relative to `--workdir`; it defaults to `ws/<runId>`. A root
that starts with `tasks/` is taken verbatim under `--workdir` (M1 compatibility),
every other root is runner-owned storage resolved inside `<workdir>/ws/`.

`source` is optional and only meaningful together with a `checkout` step. When a
project has a git repository the server injects both: `lib/runner-v2.js:83-104`
puts `{"uses":"checkout"}` in front of the step it is dispatching and fills
`workspace`/`source` from the run. A task without `source` behaves exactly like
M1.

## Execution semantics

- **Workspace**: `<workdir>/ws/<runId>` by default (see task shape for the
  `tasks/` compatibility rule). `--workdir` is resolved against the runner's
  cwd first, so a relative `--workdir` still yields one fixed absolute workspace
  path - the same one `clean` removes and `git clone` fills. `clean: true` removes the directory before the task
  runs, so two steps of the same run share one checkout only because they share
  the same `root`.
- **Cache**: with `cache` declarations the runner restores after checkout and
  before the first `run` step (`POST /cache/lookup`, exact key first and then the
  `restoreKeys` prefixes, `GET /cache/blob` for the tar.gz, unpacked into the
  workspace root), and after a `succeeded` task packs the declared `paths` that
  exist and pushes them back (`PUT /cache/blob?key=`). Archives live under
  `<workdir>/cache/` and are produced with the system `tar` (300 s cap, child
  killed on timeout); no archive library is compiled in. The whole layer is
  fail-open: a failed lookup, download, unpack, pack or upload only logs a line
  and bumps `misses`, it never changes the task's status. When `tar` cannot be
  probed the declarations are skipped and `register` omits `tar` from `tools`,
  so the server can route around it.
- **Artifacts**: after a `succeeded` task the runner globs each declared
  `paths` set inside the workspace, packs the hits with the system `tar` and
  `PUT`s them one by one to `/artifacts/:taskId/:name`, then reports
  `{name,digest,bytes}` in `/complete`. A declaration with no hit, a missing
  `tar` and a failed upload all only log a line - the server owns the verdict,
  and it fails the task with `ARTIFACT_MISSING` when a non-optional artifact
  never arrived. Because the server accepts anything it actually received over
  `PUT`, a journal replay that re-sends `/complete` without `artifacts` does not
  turn a complete upload into a missing one.
- **Credentials**: `secretRefs` (names injected under the same name) and
  `secretEnv` (`{env, ref}` mappings, which win on collision) are exchanged once
  before checkout via `/credentials`, cached in memory until `expiresAt` minus a
  30 s margin, and refreshed per step only when close to expiry. A failed exchange
  is **fail closed**: the task completes `failed` with exit code `-1` and an error
  naming the code, and no step runs. Values never reach the log, the journal, the
  `/complete` body or the disk.
- **Heartbeat**: a background task sends `POST /heartbeat` immediately after
  `register` and then once per `heartbeatSec` for the life of the process,
  carrying `stats.running` (0/1) and the live cache counters. It is decoupled from
  claim/execute, so a build longer than the server's liveness threshold
  (`heartbeatSec × 3`, 90 s by default) never looks like an offline runner. A
  failed heartbeat is logged and retried, never fatal; the task is aborted when
  the main loop exits.
- **Checkout**: a task carrying `source` runs `git clone --depth <depth>
  [--branch <ref>] -- <url> <workspace>`, followed by `git -C <workspace>
  checkout <sha>` when `sha` is present, from `<workdir>/ws` with a fixed 600 s
  timeout. A `checkout` step without `source`, a `source` whose `type` is not
  `git`, or a machine without `git` fails the task with an error naming the cause.
- **Protocol handshake (M5)**: `register` sends `protocol: 2`. The server
  answers with its `protocol` and `minProtocol`; if `minProtocol` is higher than
  the runner supports, the runner exits non-zero with a message naming the
  versions instead of running tasks under rules it does not understand. A runner
  already registered as v2 that shows up on a v1 endpoint (`/runner-poll`,
  `/runner-result`) is refused with `409 RUNNER_PROTOCOL_MISMATCH`, and a v1
  runner that calls a v2 endpoint gets the same 409 from `authenticate()` —
  `401` would send you hunting for credentials when the version is the problem.
- **Capabilities**: `register` reports `tools` (`git` when a `git` binary is
  resolvable, `tar` when a system `tar` answers); the server stores them as `tool:<name>` labels and
  refuses to queue a checkout task for a runner without `tool:git`
  (`RUNNER_CAPABILITY_MISSING`, `lib/executors.js:199-217`) instead of handing it
  a task it cannot run.
- **Steps**: sequential. `uses: "checkout"` is consumed by the workspace
  preparation above and never spawns a process. `uses: "run"` executes `command`
  through `cmd /C` on Windows and `sh -c` elsewhere, with `cwd` relative to the
  workspace root and the parent environment overridden by each entry of `env`.
  Any other `uses` value fails that step with `step N: unsupported step kind
  "<kind>"`.
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
lease to expire. Replaying `claimed` and then `finished` for the same task is
possible; the later `claimed` wins, so a task the server re-queued is executed
again.

The journal is also the resume checkpoint. When a claimed task arrives whose id
already has a `finished` line, the runner does **not** execute its steps: it
re-sends the journaled `/complete` once and moves on. Because the server
dispatches one task per step (`stepIndex`, `workspace` and `source` per task),
that task-level journal is a step-level checkpoint too - after `kill -9` and a
restart, every step whose task already finished is skipped, only the interrupted
step is reported `failed` and retried, and the run continues instead of redoing
work that already succeeded.

`<workdir>/credentials.json` stores the last issued token per runner id
(`0600` on Unix). The token is otherwise kept in memory only; it is never printed.

## Workspace TTL GC

A background task started at boot scans `<workdir>/ws/` every 60 s and removes
entries whose age exceeds their TTL (`workspace.ttlSec`, default `3600` s). A
workspace that a running task has claimed is marked active and never collected,
and its own `ttlSec` replaces the default for as long as it runs. The collector
only ever touches `ws/`; `journal.log`, `credentials.json` and a migrated
`tasks/` tree are left alone.

## Not implemented yet (M4 scope)

- **No artifact return**: `artifacts` must be empty and nothing is uploaded yet;
  artifact collection lands in M4.
- **No toolchain provisioning**: the runner never installs a JDK/Node/Maven. It
  cannot: this release's broker never emits a `toolchain` step for a v2 runner
  (`lib/executors.js`, `lib/runner-v2.js` do not send one), so there would be
  nothing to execute. Host-side pinning (`lib/toolchain.js`) stays authoritative.
  M2 promised the installer would arrive with M3's cache layer; it did not - the
  broker still emits no `toolchain` step, so the installer would have nothing to
  run. It moves to whichever milestone adds that step.
- **One step at a time**: a task is a single step; parallel jobs, matrices and
  stage DAGs stay on the server.
- **Plain HTTP only**: the HTTP client is compiled without a TLS feature, so
  `https` endpoints fail to connect and `--insecure` is accepted but has no effect.
  This is a build-environment workaround; re-enabling a rustls feature restores TLS.
- **One task at a time**: `--capacity` is advertised to the server but only one
  claim is processed concurrently.
