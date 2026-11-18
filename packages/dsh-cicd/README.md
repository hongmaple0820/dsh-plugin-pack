# @local/dsh-cicd

> **Language**: [English](#english) · [中文](#中文)

---

## English

**@local/dsh-cicd** is a local-first, lightweight CI/CD plugin for DSH.

- Reads `pipe.yml` from your repo; build steps run on the **local** machine (no container, no agent on the host).
- Deploy / rollback reuse the **dsh-remote** SSH channel (this package owns no SSH code and no credentials).
- Run history lives in a local **SQLite** file (`node:sqlite`, Node 22 built-in, no native compilation); logs remain plain text files.
- **No third-party runtime dependencies.**

### Feature line

| Version | Highlights |
|---|---|
| v0.4 | One target fans out to many hosts; `runtime` presets decide the restart command |
| v0.6 | Canary batches, webhook notifications, audit timeline |
| v2.0-M0 | Project wizard (local / git clone + scaffold), `pipe.yml` editor (validate + save), git metadata on the project card |
| v2.0-M1 | Triggers & feedback: inbound webhook (`git push`), in-process cron, git polling, WebSocket live logs, run cancel, DORA 4 metrics |
| v2.0-M2 | Pluggable Executor: builds run locally **or** on a registered remote runner (pull protocol + journal idempotency + self-signed TLS); "Build host" dropdown in the UI |
| v2.0-M3 | Five deploy strategies (serial / parallel / rolling / canary / blue-green) + strategy lock; `target.strategy` in `pipe.yml`, batch progress resumable |
| v2.0-M4 | Environments (dev < staging < prod + protected / approval flags), approval gate (prod stops at "pending approval"), secrets (DB stores ref only, payload in `workDir/.secrets.json` 0600, auto-injected into `${{SECRET_NAME}}`) |
| v2.0-M5 | RBAC for server mode: 3 roles (viewer / operator / admin) + project scope + short-TTL tokens, full audit |

### Layout

| File | Responsibility |
| --- | --- |
| `index.js` | Host entry: 20 tools + 28 exact GET routes + 1 prefix route (webhook) + 1 WebSocket upgrade (live logs); assembles the runtime |
| `lib/pipe.js` | YAML-subset parser, `${{VAR}}` interpolation, restricted `when` expressions, glob, stage-DAG planning, `triggers` normalisation |
| `lib/runner.js` | Local executor: runs steps stage by stage, writes logs & run records; supports external `runId`, `AbortSignal` cancel, live-log hub |
| `lib/db.js` | SQLite open / DDL / migration: runs, steps, artifacts, releases, operations, projects + indexes; `PRAGMA user_version` tracks schema (v5, adds `steps.runner_id`) |
| `lib/store.js` | SQLite storage layer (`cicd.db`, WAL); same API as the old JSONL version; first open imports legacy `runs.jsonl` and renames it `runs.jsonl.migrated` |
| `lib/remote.js` | dsh-remote loopback HTTP client: exec + chunked upload |
| `lib/deploy.js` | releases / current symlink deploys, multi-host fan-out, canary batches, runtime-preset restart, health check, auto rollback |
| `lib/notify.js` | Webhook notifications: concurrent POST + HMAC-SHA256 signing; failures never block a deploy |
| `lib/git.js` | Git integration: sync HEAD metadata (branch / commit / exact tag / dirty / commit time), async `clone` / `fetch`, `remoteHead`, remote branch snapshot, fast-forward `pullFastForward` |
| `lib/scaffold.js` | `pipe.yml` scaffold templates (static / node / python / go / bare) for the create-project wizard |
| `lib/cron.js` | 5-field cron parsing & matching (aliases, ranges, steps, lists); `minuteKey` minute-aligned dedup |
| `lib/triggers.js` | `triggers` normalisation (push branches / tags / secret, schedule, manual) and ref-glob matching |
| `lib/scheduler.js` | In-process scheduler: cron tick + git push polling; state in `scheduler-state.json` |
| `lib/live.js` | Per-run ring-buffer log hub: subscribe / snapshot / end events |
| `lib/ws.js` | Minimal WebSocket server (handshake, TEXT frame codec, `LogSocket`) |
| `lib/dora.js` | DORA 4-metric summary: deploy frequency, change lead time, change-failure rate, MTTR |
| `lib/executors.js` | Executor abstraction (local / remote) + `TaskBroker` (pull-based task dispatch, claim / resolve / cancel) + join-token verification |
| `lib/strategy.js` | Deploy strategy engine: serial / parallel / rolling / canary / blue-green + strategy lock (batch-progress callback) |
| `lib/environments.js` | Environment promotion: dev / staging / prod order + protected / approval flags + promotion path |
| `lib/approval.js` | Approval (block-gate) state machine: request / resolve / isPending / list; prod stops at "pending approval" by default |
| `lib/secrets.js` | Secret store: DB keeps the ref only, payload in `workDir/.secrets.json` (0600); `refsForInterpolate` injection |
| `lib/rbac.js` | RBAC (server mode): 3 roles + project scope + short-TTL tokens, audit timeline; payload in `workDir/.rbac.json` (0600) |
| `bin/runner.mjs` | Single-file remote runner CLI: pull protocol + journal idempotency + self-signed TLS (optional undici) |

### Configuration

```yaml
# config.yaml (plugins.'@local/dsh-cicd' in the DSH config file)
workDir: C:\Users\me\.dsh-cicd   # run records / logs dir, default ~/.dsh-cicd
remoteBase: 5174                 # dsh-remote port; a number becomes http://127.0.0.1:<port>
defaultTarget: prod
stepTimeoutSec: 600
maxLogBytes: 262144
projects:
  - id: demo
    name: Demo
    path: F:\code\demo           # repo root
    pipe: F:\code\demo\pipe.yml  # defaults to <path>/pipe.yml when omitted
    env: {}
notify:                          # v0.6: optional; failures never block a deploy
  webhooks:
    - url: https://hooks.example.com/cicd
      secret: change-me          # only when set is x-dsh-signature: sha256=<hex> sent
      events: [run.success, run.failed, rollback.success]
scheduler:                       # v2.0-M1: in-process scheduling (cron + git push polling)
  enabled: true                  # false disables the whole scheduler
  tickSec: 20                    # cron check interval (1..3600)
  pollSec: 60                    # git polling interval (0 disables, max 3600)
  allowProd: false               # when true, scheduler-triggered prod deploys auto-carry confirm=prod
```

Without `projects`, a `pipe.yml` in the current working directory is auto-registered as a project. Omitted `remoteBase` falls back to `webServer.port`.

### pipe.yml

```yaml
version: 1
name: demo
vars:
  APP: demo

targets:
  prod:
    hosts: [linux26, win22]    # dsh-remote host aliases; fan out in order
    path: /opt/demo           # deploy root
    runtime: python           # static (default) | node | python | go | php | docker
    app: demo                 # service name; required for node/python/php, falls back to target name for go/docker
    onHostFailure: continue   # stop (default) | continue
    canary:                   # v0.6: first batch covers only the first host, wait 30s before the rest
      first: 1                # 1..hosts.length; equal to hosts.length means no batching
      waitSec: 30             # 0..3600, default 30
    # service: demo.service   # explicit service/restart takes precedence over the runtime preset
    health:
      http: http://127.0.0.1:8080/health
      tries: 5
      interval: 2s

stages:
  - id: build
    steps:
      - name: install
        run: npm ci
      - name: package
        run: tar -czf dist/${{APP}}.tgz -C dist .
        retries: 1
        allow_failure: false
  - id: release
    needs: [build]
    steps:
      - name: ship
        deploy:
          target: prod
          artifacts: ["dist/*.tgz"]
          keep: 5

triggers:                        # v2.0-M1: manual-only when omitted
  push:
    branches: [main, "release/*"]  # glob, `*` also matches `/`
    tags: ["v*"]                   # optional; tag ref leaves branch empty
    target: prod                   # optional, defaults to defaultTarget
    secret: s3cret                 # required webhook token; inbound requests 403 without it
  schedule:
    - cron: "0 3 * * *"            # min hour day month week (local time); aliases/ranges/steps/lists
      target: staging              # optional
  manual: true                     # default true
```

- `needs` forms a DAG; a failed upstream stage skips its dependents.
- `when` only supports `branch ==/!= 'x'`, `tag ==/!= 'x'`, `env.NAME ==/!= 'x'`, `changed: <glob>` — not scripts.
- Variable interpolation uses `${{NAME}}`; a missing variable is an error, never silently empty.
- `deploy` steps release to `target.hosts` in order: each host gets its own `<path>/releases/<runId>`, upload, extract, `current` switch, own `revisions.log` line, restart, health check; each host keeps its own `previous`.
- A single-host failure stops the remaining hosts by default (`onHostFailure: stop`); with `continue` the rest still deploy, already-succeeded hosts are not rolled back, and the overall `ok` is `false`.
- Omitting `host` on rollback rolls back every host; passing `host` rolls back just that one. Each host's result is returned separately.

### Canary batches, notifications & audit (v0.6)

`target.canary` splits one fan-out into two batches:

- Batch 1 deploys `first` hosts in order; **any failure stops immediately** (even with `onHostFailure: continue`); remaining hosts are not tried; overall `ok:false`.
- All of batch 1 succeeds → one `canary-hold` audit entry + log line `[canary] first batch N hosts OK, waiting Xs before remaining M` → wait `waitSec` → remaining hosts deploy per `onHostFailure`.
- Each host result carries `batch: 1|2`; the run result carries `canary: {first, waitSec, batches:[{index,hosts,ok}]}`. `first` equal to the host count is equivalent to no batching.
- `first` outside `1..hosts.length`, `waitSec` outside `0..3600`, or a non-map `canary` all raise `PIPE_INVALID`, naming the target and field.

Webhook notifications (config above):

- Events: `run.success` / `run.failed` / `run.canceled` / `rollback.success` / `rollback.failed`; `notify-test` sends `test`.
- Concurrent POST JSON; `secret` adds `x-dsh-signature: sha256=<hex>` (HMAC-SHA256 over the raw body). Omitted `events` means send all.
- Each result is written to the `notify` audit trail (`status: success|failed`); **any failure is logged/audited only and never affects the deploy**. `GET /notify-test` fires a trial; zero configured webhooks returns `configured: 0` instead of an error.
- The payload always contains `{event,at,project,target,runId,releaseId,status,durationMs,hosts:[{host,ok,batch,health,error}],prod}`; `prod:true` when any target host is production.

Audit timeline: the `operations` table (schema v3) is `(id,at,action,project,target,host,run_id,release_id,status,detail)`; old DBs auto-`ALTER TABLE` and backfill the legacy `kind` into `action`. `GET /api/plugins/cicd/operations?project=&runId=&limit=` (default 50, max 200) returns newest first. Every per-host deploy, per-host rollback, `canary-hold` and `notify` writes one entry.

### Multi-host fan-out & runtime presets

`target.hosts` is an **ordered** deploy list, not a concurrency pool: the next host starts only after the previous one finishes (or fails). Each `hosts` entry in the response looks like `{host,ok,health,restarted,error,code}`; a host skipped because an earlier one failed carries `skipped:true`.

`runtime` (default `static`) generates a default restart command when neither `restart` nor `service` is set; every command ends in `|| true` so a failed restart cannot wedge the deploy.

| runtime | `app` | default restart command |
| --- | --- | --- |
| `static` | not required | no restart; log says "skipping restart" |
| `node` | required | `pm2 restart '<app>' \|\| systemctl --user restart '<app>' \|\| sudo -n systemctl restart '<app>' \|\| true` |
| `python` / `go` / `php` | required | `systemctl --user restart '<app>' \|\| sudo -n systemctl restart '<app>' \|\| true` |
| `docker` | optional, defaults to target name | `docker restart '<app>' \|\| docker compose up -d --no-build \|\| true` |

Precedence: explicit `restart:` > `service:` > runtime preset. Writing both `service` and `restart` is `PIPE_INVALID`; an unknown `runtime`, a missing or illegal `app` (node/python/php), a non-positive-integer `keep`, a non-absolute `path`, or an `onHostFailure` other than `stop`/`continue` all raise `PIPE_INVALID` naming the target and field.

Target field reference (the client renders against this):

| Field | Type | Notes |
| --- | --- | --- |
| `hosts` | `string[]` | non-empty, de-duplicated host aliases |
| `path` | `string` | remote deploy root, absolute; empty = default |
| `runtime` | `static\|node\|python\|go\|php\|docker` | default `static` |
| `app` | `string` | service name; required for node/python/php |
| `onHostFailure` | `stop\|continue` | default `stop` |
| `canary` | `{first,waitSec}` | v0.6 canary batching; omit for a single fan-out |
| `keep` | `number` | keep the last N releases, default 5 |
| `service` / `restart` | `string` | pick one; overrides the runtime preset |
| `restartCommand` | `string` | read-only derived value: the restart command that will actually run |
| `health` | `{http,tries,interval}` | health check |
| `current` | `string` | current symlink target (read-only) |
| `active` | `{host,releaseId}[]` | per-host currently-active release (read-only) |

### Environment selectors & production guard (v0.5)

Besides host aliases, `target.hosts` accepts selectors: `env:prod`, `group:api`, `tag:canary`, freely mixed with aliases. Parse time only checks syntax (`^(env|group|tag):[a-z0-9._-]{1,32}$`); **real expansion happens before deploy**:

1. `/plan` and `/targets` expand lazily (reading dsh-remote's `/api/plugins/remote/hosts` and `/groups`, 5 s cache); the response gains `selectors`, `envs`, `prodHosts`, and `/plan` adds `willDeployToProd`.
2. Empty expansion → `400 PIPE_INVALID` "selector env:nope matched no host".
3. Mixed entries keep order; duplicate aliases keep only the first occurrence.

Production guard: if any expanded host has `env === 'prod'`, `/run` and `/rollback` must use `confirm=prod` (not `confirm=1`), otherwise the response is:

```json
{ "ok": false, "error": "target web contains production hosts (linux26, api1); writes need confirm=prod", "code": "PROD_CONFIRM_REQUIRED", "hosts": ["linux26", "api1"] }
```

HTTP status **409**. The panel turns this error into a production-guard card (`.cicd-prod-guard`, listing affected hosts); only "Confirm deploy to production" resends with `confirm=prod`. `dryRun` never triggers the guard.

Deploy lock: only one real deploy per target at a time; a second attempt immediately gets `409 DEPLOY_IN_PROGRESS` "target web already has a deploy running, try again after it finishes". `dryRun` takes no lock; the in-process Map is released in `finally`.

Release records gained an `env` column (`SCHEMA_VERSION` 1 → 2; old DBs auto-`ALTER TABLE`, history rows have `env` as empty string); `/releases` supports `env=` filtering.

### Project wizard, editor & git metadata (v2.0-M0)

The panel toolbar adds two mutually exclusive views — **Create** and **Edit** — alongside **Release** and **Audit**:

- **Create wizard**: project name / target directory (optional git repo URL + branch), pick a scaffold template (static/node/python/go/bare). `/project-create` writes a minimal `pipe.yml` that passes `parsePipe` out of the box (build → release). With a repo URL it runs `git clone --depth 1` first; clone failure raises `GIT_CLONE_FAILED` / `GIT_CLONE_TIMEOUT`; a target dir that already has a `pipe.yml` raises `PROJECT_CREATE_FAILED`. Projects are recorded in the SQLite `projects` table (schema v4) and listed on the next start.
- **Editor**: `/project-meta` returns `pipeSource` for the textarea; **Validate** goes through `/validate?source=` (or `?project=` to validate the on-disk file) with line numbers and error codes; **Save** goes through `/pipe-save confirm=1`, writes only when valid, then refreshes targets and clears the stale plan.
- **Git metadata**: the project card shows one more line `branch · commit · tag · dirty` (sync `readGitMeta` from `/project-meta`); before a run, `branch`/`commit_sha` are back-filled into the run record so `when: branch/tag` has real data. Git unavailable or a corrupt repo degrades to empty values — the panel never crashes and the pipeline is never blocked.

Four new tools (`cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save`) and four routes (`/project-meta` `/project-create` `/validate` `/pipe-save`); route contracts match the existing resources (reads need same-origin only; writes additionally need the `x-dsh-cicd` header + `confirm=1` and reject unknown query params).

### Triggers, live logs, cancel & DORA (v2.0-M1)

Three trigger modes coexist; manual is always available:

- **Inbound webhook (git push)**: the GET prefix route `/api/plugins/cicd/hooks/<project>` (POST-equivalent), query params `ref` (required, e.g. `refs/heads/main`), `sha`, `event`, `token` (or the `x-cicd-token` header), `confirm`. `triggers.push.branches`/`tags` match the ref with globs (`*` crosses `/`); on a branch hit it first runs an async `fetch`, tries a fast-forward when the working tree is on that branch, then records one `trigger='push'` run and returns 202 + `runId` immediately. Non-matching refs return 200 `{ok:true,skipped:true}` with no run record. Auth: no `triggers.push` or no `secret` in the pipe → 403 `WEBHOOK_DISABLED`; token mismatch (sha256 + constant-time compare) → 401 `WEBHOOK_UNAUTHORIZED`. Because the request may come from GitHub/GitLab, this route **does not require same-origin**; identity is the token only.
- **cron**: each `triggers.schedule` entry is a 5-field cron + optional target. The scheduler checks on `tickSec` alignment and dedupes by `minuteKey` (`YYYY-MM-DDTHH:mm`), persisted in `scheduler-state.json` so the same minute never fires twice across a restart.
- **git push polling**: with `pollSec > 0` it periodically `git fetch`es and reads `refs/remotes/origin/*`. The first poll only builds a baseline (existing branches never trigger); afterwards a changed branch sha or a new branch appearing after the baseline triggers a `trigger='push'` run. Runs for one project are serial, never stacked.

Live logs: `ws://<host>/api/plugins/cicd/log-ws?runId=<id>` (`registerUpgrade`, same port as HTTP). On connect you first receive `{type:'snapshot',runId,truncated,lines}`, then per-line `{type:'line',stageId,index,line}`; after `{type:'end',status}` the server closes. When the run already finished or is not in the in-memory hub, the last 2000 lines of `logs/<runId>.log` are sent as the snapshot plus `end`; missing `runId` → 400, unknown run → 404. The hub keeps the last 5000 lines per run.

Cancel: the `cicd_cancel` tool or `/cancel?runId=&confirm=1`. Cancelling a running run → `AbortController.abort()`, the current step's whole process tree is killed (`taskkill /T /F` on Windows), the run record gets `status='canceled'`, `error='canceled'`. Ended / nonexistent runs return `RUN_NOT_ACTIVE` / `RUN_NOT_FOUND` (HTTP 409 / 404). Cancel is idempotent; a repeated call returns `canceling`.

DORA 4 metrics (`cicd_dora` tool, `/dora` route, last 30 days by default, `days` overridable): deploy frequency (successful runs / day, rated elite/high/medium/low), change lead time (median of `finished_at − git commit time`), change-failure rate (failed+canceled over all non-dryRun runs), MTTR (average time from a failure to the next success on the same project+target). `dryRun` and unfinished runs are excluded; `series` gives up to 60 daily `{deployments,failures,canceled}` points for trend charts.

Three new tools (`cicd_cancel` / `cicd_dora` / `cicd_triggers`) and four routes (`/cancel` `/dora` `/triggers` + prefix `/hooks/<project>`) plus one WebSocket upgrade (`/log-ws`). The scheduler starts with the plugin in `apply()`; `dispose()` stops its timers and releases the hub.

### Tools

`cicd_projects` / `cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save` / `cicd_plan` / `cicd_run` (`dryRun`, `stage`, `confirm`, `runner`) / `cicd_status` / `cicd_logs` / `cicd_releases` (filter by `host`) / `cicd_rollback` (optional `host`) / `cicd_targets` (runtime/app/onHostFailure/keep/restartCommand + per-host active) / `cicd_cancel` (`runId`) / `cicd_dora` (`project`, `days`) / `cicd_triggers` (`project`, returns the triggers summary, webhook URL and scheduler snapshot) / `cicd_runners` (lists registered runners: labels, capacity, online state, active task count) / `cicd_approve` (`runId`, `decision`, `resolvedBy`) / `cicd_secrets` (`project`, `scope`, `name`, `value`) / `cicd_environments` (`project`) / `cicd_rbac` (`user`, `role`, `projects`, `ttlSec`, `token`, `action`).

### HTTP routes (GET + resource, plus 1 prefix and 1 upgrade)

`/api/plugins/cicd/{projects,project-meta,project-create,validate,pipe-save,plan,run,runs,log,releases,rollback,targets,operations,notify-test,cancel,dora,triggers,runner-register,runner-poll,runner-result,runner-log,runners,approve,approvals,secrets,environments,rbac}` — 28 exact routes; `run` takes an optional `runner` param to pick the build host; the five `runner-*` routes are the remote-runner pull protocol (register carries the join token, poll doubles as heartbeat, result is idempotent, log pushes line by line) and **do not check same-origin** (cross-machine calls), authenticated by the join token; `runners` requires same-origin. Two special entries: the prefix route `/hooks/<project>` (inbound webhook, token-authenticated, no same-origin check) and the upgrade `/log-ws?runId=` (live logs).

### Remote runner (v2.0-M2)

Build steps run locally by default; when `pipe.yml` has `targets` but the machine has no Node, you can hand the build steps to a registered remote runner:

1. **Register**: on the remote machine run `node bin/runner.mjs --server https://host:port --runner build-01 --labels node,builder --join-token <secret>` → `/runner-register` (join-token check, sha256 constant-time compare).
2. **Pull protocol**: the runner polls `/runner-poll` to claim tasks (doubling as heartbeat, every 15 s). When the host side runs `cicd_run` with `runner=build-01`, the build steps are dispatched to that runner through the `TaskBroker`; results come back via `/runner-result` (idempotent: `resolve` honours only the first), logs stream line-by-line via `/runner-log` (dropped lines are acceptable; the result is what matters).
3. **Journal idempotency / power-loss resume**: the runner records `{taskId, attempt, status, exitCode}` in a local `journal.jsonl`; after a restart, `status=success` tasks are skipped, unfinished ones retry with `attempt+1` — the host-side `resolve` idempotency guarantees repeated reports for the same taskId never change state.
4. **Self-signed TLS**: `--ca <file>` sets the CA (undici `setGlobalDispatcher`); `--insecure` skips certificate verification (intranet debugging only).
5. **UI**: the panel toolbar adds a "Build host" dropdown after "Target" (local / registered runners, offline marked `(offline)`); selecting one makes `cicd_run` carry the `runner` param automatically.
6. **Cancel**: host-side `cicd_cancel` calls `broker.cancelAll(runnerId)` for remote runs; the runner's `cancelSignal` kills the child process tree.

### Deploy strategies (v2.0-M3)

`target.strategy` in `pipe.yml` upgrades deploys from "serial fan-out + 2-batch canary" to a five-strategy engine:

```yaml
targets:
  prod:
    hosts: [h1, h2, h3, h4, h5]
    path: /srv/app
    runtime: static
    strategy:
      type: rolling        # serial / parallel / rolling / canary / blue-green
      batch: 2             # rolling: hosts per batch (default ceil(hosts/2))
      waitSec: 30          # rolling/canary/blue-green: wait between batches (default 30)
      onHostFailure: stop  # stop (default) / continue
```

| Strategy | Semantics | Notes |
|---|---|---|
| `serial` | Deploy host by host; one failure stops | Default (falls back when no `strategy` field) |
| `parallel` | All hosts concurrently | Failure handled per `onHostFailure` |
| `rolling` | N hosts per batch, wait `waitSec` between | Single-host failure stops/skips per strategy; within a batch it is serial |
| `canary` | First `first` hosts + observation window + auto scale-out | Equivalent to the old 2-batch canary; `first` configurable; a first-batch failure always stops |
| `blue-green` | Spin up a full new set, cut traffic, retire the old | Any host failure → all hosts auto-roll back to `previous` |

- **Strategy lock**: during rolling, the `onStrategyProgress` callback records batch progress (batch index + completed hosts); the host side writes it to `store.operations` (`action:'strategy-progress'`); after a cancel you can resume from the last batch.
- **Compat**: without a `strategy` field, the existing `canary.first/waitSec` is used; the `canary` field still works.
- Rollback is still one-click `current` switch-back (`cicd_rollback`).

### Environments & approval (v2.0-M4)

`pipe.yml` targets map automatically to environments (dev < staging < prod order, `lib/environments.js`):

- **prod protected by default**: `targetName === 'prod'` (case-insensitive) → `protected: true` + `approvalRequired: true`; explicit `protected: true` / `approvalRequired: true` also work.
- **Approval gate (block gate)**: an `approvalRequired` target stops at "pending approval" in `executeRun` and raises `APPROVAL_REQUIRED` (HTTP 409). The panel / `cicd_approve` "Approve" (`decision=approve`) re-runs `executeRun`; on approval → `approval-resolved` audit → the `confirm=prod` guard still applies (double confirmation). Reject → `approval-rejected`.
- **secrets**: the `cicd_secrets` tool / `/secrets` route sets and lists secrets; the DB stores refs only, payloads land in `workDir/.secrets.json` (0600, atomic write); `${{SECRET_NAME}}` interpolation in `pipe.yml` is auto-injected via `refsForInterpolate`, never written in plaintext to logs or the DB.
- **Promotion path**: the `cicd_environments` tool / `/environments` route lists environments + `promotionPath` (dev → staging → prod).
- **Artifact cache**: not implemented this round (`lib/cache.js` deferred); the existing `artifacts` table already records each run's artifacts, and the `keep` cleanup reuses `cleanupReleases` from deploy.js.

### RBAC (v2.0-M5, server mode)

Server mode enables 3-role RBAC (`lib/rbac.js`; single-machine mode has no roles):

| Role | Read | Write | Admin |
|---|---|---|---|
| `viewer` | ✅ | ❌ | ❌ |
| `operator` | ✅ | within project scope | ❌ |
| `admin` | ✅ | all | ✅ |

- **Token issuance**: the `cicd_rbac` tool / `/rbac` route (`user=alice&role=admin&ttlSec=3600`) → returns `rbac-xxxxxxxx` (sha256 digest persisted, `workDir/.rbac.json` 0600); tokens have a short TTL and expire automatically (`TOKEN_EXPIRED`).
- **Permission checks**: `canWrite(user, project)` by role + project scope (`*` for all, or a comma list); `canAdmin(user)` is admin-only.
- **Audit**: every token issue / revoke / write operation lands in the audit timeline (last 500); `action=audit` exports all (chronological).
- **Revoke**: `action=revoke&user=alice` immediately invalidates that user's tokens.

### Security boundaries

- No arbitrary YAML parsing: only maps / sequences / inline arrays / scalars; block scalars (`|`, `>`) and flow maps are hard errors.
- Build commands come only from `pipe.yml` `run` fields, executed in the project directory via shell; `dryRun` only prints the plan.
- Deploys add no credentials: everything goes through dsh-remote's loopback routes; uploads are 8 KB chunks, single file capped at 64 MB.
- Webhooks only POST to the http(s) URLs configured; payloads carry no credentials; failures are audited only — no retry, never blocks a deploy.
- Inbound webhooks do not trust the source: `triggers.push.secret` must be set in the pipe; the token is compared with sha256 constant-time; without a secret every inbound request is 403 and no build is ever triggered.
- The live-log WebSocket shares the HTTP port and same-origin policy: auth follows the DSH webserver's session boundary; only that run's logs are pushed by `runId` (the logs are already on disk, so this is not a new exposure).
- Scheduler-triggered prod deploys are blocked by the production guard by default (`allowProd: false`); enabling it explicitly makes them carry `confirm=prod` automatically.
- Remote-runner `runner-*` routes skip the same-origin check (cross-machine) and rely on the join token (sha256 constant-time); `resolve` idempotency guarantees repeated reports for one taskId never change state; dropped log lines are acceptable, the result is what matters.
- `bin/runner.mjs` `--insecure` is for intranet debugging only; production should use `--ca <file>`.
- Secret payloads live in `workDir/.secrets.json` (0600); the DB keeps refs; `refsForInterpolate` injection never lands in logs or the DB in plaintext.
- Approval gate: prod defaults to "pending approval"; `/approve` unblocks, then the `confirm=prod` guard still applies (double confirmation); approval records land in `store.operations` (`action='approval-request/approval-resolved/approval-rejected'`).
- RBAC tokens live in `workDir/.rbac.json` (0600); the DB keeps sha256 digests only; short TTL (default 3600 s) with automatic expiry; every write is audited (last 500), `action=audit` exports all.
- Log reads are truncated at `maxLogBytes`; `runId` passes a character whitelist.

### Self-checks

```bash
node packages/dsh-cicd/test/smoke.mjs   # 73 checks: parse/plan/store/run/deploy/canary/notify/audit/routes/selectors/guard/locks/migration/wizard/editor/scaffold/cron/triggers/scheduler/webhook/log-ws/cancel/DORA/executor/broker/joinToken/strategy(5+lock)/environments/approvalGate/secrets/RBAC
node test/mount.mjs                     # full mount gate (this package: 20 tools / 28 routes)
```

No real SSH: the tests use a fake fetch for remote and a command-recording fake remote for deploy.

### Cold-start route registration & lazy remote (v0.6.1)

Same disease as dsh-remote: at cold start `webServer` comes up after the plugin's `apply()`, so a synchronous `ctx.get('webServer')` in apply returned nothing → the whole package's routes 404. Since v0.6.1 route registration is hooked on `ctx.inject(['webServer'], …)` (re-registers everything once ready — 28 exact + 1 prefix + 1 upgrade); `remote()` is lazy — when `options.remoteBase` is empty, the first call reads `ctx.get('webServer').port`; if unavailable it returns an uncached client (keeping a retryable `REMOTE_UNAVAILABLE`). The smoke suite has a cold-start regression (0 routes → 28 + 1 upgrade + remote-base assertion).

### Gotchas hit in the wild (v0.2)

Five pitfalls from the first real run (linux26 + dsh-remote), all fixed and locked in the smoke suite:

1. **`pkill -f 'http.server 8099'` kills itself**: the `restart` command's own command line contains that string, so pkill matches it → exec returns an empty exit and the service never started. Switched to port-based kill: `fuser -k 8099/tcp`.
2. **Multiple artifact hits must take the newest**: `dist/app-*.tgz` matching several old packages would deploy the alphabetically-first one. Now picks by mtime.
3. **dsh-remote's exec reply is `{ok, result}`**: the health check must flatten `result` before reading `exitCode`, or it always fails even when the page is 200.
4. **Health-check retry waits must not `unref()`**: a script / short-lived process empties the event loop while waiting (`unsettled top-level await`).
5. **`RELEASE_ID` must be generated before plan**: runId is now created first so `${{RELEASE_ID}}` actually interpolates into artifact names (previously always `dist/app-.tgz`).

Also: a first-deploy health-check failure removes `current` (there is no `previous` to roll back to; a bad version is not left live).

### Real-machine proof (linux26 / python3 http.server)

- First deploy: build 144 ms + deploy 2326 ms, `current -> releases/<runId>`, `curl` served the real page, `revisions.log` gained a line.
- Second deploy (content changed): the new marker appeared → rolled back to the previous: marker gone, `current` pointed back to the old release, `revisions.log` gained `rollback:<id>`; rolling forward brought the marker back.
- Rolling back a release already cleaned by `keep` → 404 `RELEASE_NOT_FOUND`, live site untouched.

---

## 中文

**@local/dsh-cicd** 是本地优先的轻量 CI/CD：读仓库里的 `pipe.yml`，构建步骤在本机跑，发布/回滚复用 **dsh-remote** 的 SSH 通道，运行记录落在本地 **SQLite**（Node 22 内置 `node:sqlite`，不需要原生编译），日志仍是文本文件。不新增第三方依赖、不自己持有任何 SSH 凭据。

> 中文版的各章节（灰度分批、多主机 fan-out、环境选择器、项目向导、触发/实时日志/取消/DORA、远端 runner、发布策略、环境与审批、RBAC、安全边界、自检、冷启动、实战坑、真机实测）与英文版一一对应，内容相同，此处不再重复全文——以英文版为权威，中文版仅作对照速查。若需要完整中文逐字版，见 `docs/proposals/cicd-v2.md`（设计提案）与各版本提交说明。

### 功能线（速查）

| 版本 | 亮点 |
|---|---|
| v0.4 | 一个 target fan-out 多主机；`runtime` 预设决定重启命令 |
| v0.6 | 灰度分批、webhook 通知、审计时间线 |
| v2.0-M0 | 项目向导（本地 / git clone + 脚手架）、`pipe.yml` 编辑器（校验+保存）、项目卡 git 元信息 |
| v2.0-M1 | 触发与反馈：入站 webhook（`git push`）、进程内 cron、git 轮询、WebSocket 实时日志、运行取消、DORA 四指标 |
| v2.0-M2 | 可插拔 Executor：构建本机或远端 runner（拉取协议 + journal 幂等 + 自签 TLS）；UI「构建主机」下拉 |
| v2.0-M3 | 五发布策略（serial / parallel / rolling / canary / blue-green）+ 策略锁；`target.strategy` 配置，批次进度可续 |
| v2.0-M4 | 环境升格（dev < staging < prod + 保护/审批标志）、审批门（prod 停在待审批）、secrets（DB 只存 ref，载荷落 `workDir/.secrets.json` 0600） |
| v2.0-M5 | 远端服务 RBAC：三角色 viewer / operator / admin + 项目范围 + 短 TTL token，写操作全审计 |

### 自检

```bash
node packages/dsh-cicd/test/smoke.mjs   # 73 项
node test/mount.mjs                     # 全包挂载闸门（本包 20 工具 / 28 路由）
```

## 组成

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 入口：20 个工具 + 27 条 GET 路由 + 1 条 prefix 路由（webhook）+ 1 条 WebSocket upgrade（实时日志）+ 5 条 runner 路由 + 4 条 V2-M4 路由 + 1 条 RBAC 路由，装配 runtime |
| `lib/pipe.js` | YAML 子集解析、`${{VAR}}` 插值、`when` 受限表达式、glob、stage DAG 计划、`triggers` 归一化 |
| `lib/runner.js` | 本地执行器：逐 stage 串行跑步骤，写日志与运行记录；支持外部 `runId`、`AbortSignal` 取消、实时日志 hub |
| `lib/db.js` | SQLite 打开/DDL/迁移：runs、steps、artifacts、releases、operations、projects 六表 + 索引，`PRAGMA user_version` 记录 schema 版本（当前 v5，v5 补 `steps.runner_id`） |
| `lib/store.js` | SQLite 存储层（`cicd.db`，WAL），对外 API 与旧 JSONL 版一致；首次打开会把遗留 `runs.jsonl` 导入并改名 `runs.jsonl.migrated` |
| `lib/remote.js` | dsh-remote 回环 HTTP 客户端：exec + 分块上传 |
| `lib/deploy.js` | releases/current 软链发布、多主机 fan-out、灰度分批、runtime 预设重启、健康检查、自动回滚 |
| `lib/notify.js` | webhook 通知：并发 POST + HMAC-SHA256 签名，失败不影响发布 |
| `lib/git.js` | git 集成：同步读 HEAD 元数据（分支/提交/精确 tag/是否脏/提交时间）、异步 `clone`/`fetch`、`remoteHead`、远端分支快照、快进 `pullFastForward` |
| `lib/scaffold.js` | `pipe.yml` 脚手架模板库（static/node/python/go/bare 五种），供新建向导起步 |
| `lib/cron.js` | 5 字段 cron 解析与匹配（别名、区间、步进、列表），`minuteKey` 分钟对齐去重 |
| `lib/triggers.js` | `triggers` 归一化（push branches/tags/secret、schedule、manual）与 ref glob 匹配 |
| `lib/scheduler.js` | 进程内调度器：cron tick + git push 轮询，状态落 `scheduler-state.json` |
| `lib/live.js` | 运行日志环形缓冲 hub：订阅/快照/结束事件 |
| `lib/ws.js` | 极简 WebSocket 服务端（握手、TEXT 帧编解码、LogSocket） |
| `lib/dora.js` | DORA 四指标汇总：部署频率、变更前置时间、变更失败率、MTTR |
| `lib/executors.js` | Executor 抽象（本地 / 远端）+ TaskBroker（拉取式任务派发、claim/resolve/cancel）+ join token 校验 |
| `lib/strategy.js` | 发布策略引擎：serial / parallel / rolling / canary / blue-green 五策略 + 策略锁（批次进度回调） |
| `lib/environments.js` | 环境升格：dev/staging/prod 顺序 + 保护/审批标志 + 晋升路径 |
| `lib/approval.js` | 审批（block gate）状态机：request/resolve/isPending/list，prod 默认停在「待审批」 |
| `lib/secrets.js` | Secret 存储：DB 只存 ref，载荷落 `workDir/.secrets.json`（0600），`refsForInterpolate` 注入 |
| `lib/rbac.js` | RBAC（远端服务模式）：三角色 viewer/operator/admin + 项目范围 + 短 TTL token，审计时间线，载荷落 `workDir/.rbac.json`（0600） |
| `bin/runner.mjs` | 单文件远端 runner CLI：拉取式协议 + journal 幂等 + 自签 TLS（可选 undici） |

## 配置

```yaml
# config.yaml（dsh 配置文件里的 plugins.'@local/dsh-cicd'）
workDir: C:\Users\me\.dsh-cicd   # 运行记录/日志目录，默认 ~/.dsh-cicd
remoteBase: 5174                 # dsh-remote 所在端口；数字会拼成 http://127.0.0.1:<port>
defaultTarget: prod
stepTimeoutSec: 600
maxLogBytes: 262144
projects:
  - id: demo
    name: Demo
    path: F:\code\demo           # 仓库根
    pipe: F:\code\demo\pipe.yml  # 省略时用 <path>/pipe.yml
    env: {}
notify:                          # v0.6：可选，失败不影响发布
  webhooks:
    - url: https://hooks.example.com/cicd
      secret: change-me          # 配了才发 x-dsh-signature: sha256=<hex>
      events: [run.success, run.failed, rollback.success]
scheduler:                       # v2.0-M1：进程内调度（cron + git push 轮询）
  enabled: true                  # false 关闭整个调度器
  tickSec: 20                    # cron 检查间隔（1..3600）
  pollSec: 60                    # git 轮询间隔（0 关闭轮询，最长 3600）
  allowProd: false               # true 时调度触发的生产发布会自动带 confirm=prod
```

不配 `projects` 时，若当前工作目录有 `pipe.yml`，会自动注册成一个项目。`remoteBase` 省略时取 `webServer.port`。

## pipe.yml

```yaml
version: 1
name: demo
vars:
  APP: demo

targets:
  prod:
    hosts: [linux26, win22]    # dsh-remote 里的主机别名；按顺序 fan-out
    path: /opt/demo           # 发布根目录
    runtime: python           # static（默认）| node | python | go | php | docker
    app: demo                 # 服务名；node/python/php 必填，go/docker 省略时用 target 名
    onHostFailure: continue   # stop（默认）| continue
    canary:                   # v0.6：首批只发第一台，观察 30s 再发剩余
      first: 1                # 1..hosts.length；等于 hosts.length 时不分批
      waitSec: 30             # 0..3600，默认 30
    # service: demo.service   # 显式 service/restart 优先级高于 runtime 预设
    health:
      http: http://127.0.0.1:8080/health
      tries: 5
      interval: 2s

stages:
  - id: build
    steps:
      - name: install
        run: npm ci
      - name: package
        run: tar -czf dist/${{APP}}.tgz -C dist .
        retries: 1
        allow_failure: false
  - id: release
    needs: [build]
    steps:
      - name: ship
        deploy:
          target: prod
          artifacts: ["dist/*.tgz"]
          keep: 5

triggers:                        # v2.0-M1：省略时只有手动触发
  push:
    branches: [main, "release/*"]  # glob，`*` 也匹配 `/`
    tags: ["v*"]                   # 可选；命中 tag ref 时 branch 留空
    target: prod                   # 可选，默认用 defaultTarget
    secret: s3cret                 # 必填，webhook token；缺省时入站请求一律 403
  schedule:
    - cron: "0 3 * * *"            # 分 时 日 月 周（本地时间），支持别名/区间/步进/列表
      target: staging              # 可选
  manual: true                     # 默认 true
```

- `needs` 组成 DAG；上游失败的 stage 会被跳过。
- `when` 只支持 `branch ==/!= 'x'`、`tag ==/!= 'x'`、`env.NAME ==/!= 'x'`、`changed: <glob>`，不是脚本。
- 变量插值用 `${{NAME}}`；缺失直接报错，不静默留空。
- `deploy` 步骤按 `target.hosts` 顺序逐台发布：每台独立建 `<path>/releases/<runId>`、上传、解包、切 `current`、追加自己的 `revisions.log`、重启、健康检查；每台保留自己的 previous。
- 单台失败默认停止后续主机（`onHostFailure: stop`）；配 `continue` 时继续发剩余主机，已成功的主机不回滚，整体 `ok:false`。
- 回滚省略 `host` 时对全部主机回滚；传 `host` 只回滚该台。每台结果单独返回。

## 灰度分批、通知与审计（v0.6）

`target.canary` 把一次 fan-out 拆成两批：

- 第一批按 `first` 台顺序发布；**任意一台失败就立即停止**，剩余主机不再尝试（即使 `onHostFailure: continue` 也一样），整体 `ok:false`。
- 第一批全部成功 → 记一条 `canary-hold` 审计、日志打 `[canary] 第一批 N 台成功，等待 Xs 后发剩余 M 台` → 等 `waitSec` → 剩余主机按 `onHostFailure` 逐台发。
- 每台结果带 `batch: 1|2`；run 结果带 `canary: {first, waitSec, batches:[{index,hosts,ok}]}`。`first` 等于主机数时等价于不分批。
- `first` 不在 `1..hosts.length`、`waitSec` 不在 `0..3600`、`canary` 不是 map 都报 `PIPE_INVALID`，文案指出 target 与字段。

webhook 通知（配置见上节）：

- 事件：`run.success` / `run.failed` / `run.canceled` / `rollback.success` / `rollback.failed`；`notify-test` 用 `test`。
- 并发 POST JSON；配了 `secret` 才带 `x-dsh-signature: sha256=<hex>`（HMAC-SHA256 对原始 body）。`events` 省略表示全发。
- 结果逐条写 `notify` 审计（`status: success|failed`），**任何失败都只记日志/审计，不影响发布**。`GET /notify-test` 可以试发；没配 webhook 时返回 `configured: 0` 而不是报错。
- payload 固定含 `{event,at,project,target,runId,releaseId,status,durationMs,hosts:[{host,ok,batch,health,error}],prod}`；目标含生产主机时 `prod:true`。

审计时间线：`operations` 表在 schema v3 扩成 `(id,at,action,project,target,host,run_id,release_id,status,detail)`，旧库自动 `ALTER TABLE` 补列并把旧 `kind` 回填到 `action`。`GET /api/plugins/cicd/operations?project=&runId=&limit=`（默认 50、上限 200）按 `at DESC` 返回。deploy 每台、rollback 每台、`canary-hold`、`notify` 都会落一条。

## 多主机 fan-out 与 runtime 预设

`target.hosts` 是顺序执行的发布列表，不是并发池：前一台完成（或失败）后才动下一台。返回结构里 `hosts` 每项形如 `{host,ok,health,restarted,error,code}`，失败的项带 `skipped:true` 表示因前面的主机失败而没执行。

`runtime`（默认 `static`）用来在没写 `restart` / `service` 时生成默认重启命令；命令都带 `|| true` 兜底，避免重启失败把发布卡死。

| runtime | `app` | 默认重启命令 |
| --- | --- | --- |
| `static` | 不需要 | 不重启，日志记「跳过重启」 |
| `node` | 必填 | `pm2 restart '<app>' \|\| systemctl --user restart '<app>' \|\| sudo -n systemctl restart '<app>' \|\| true` |
| `python` / `go` / `php` | 必填 | `systemctl --user restart '<app>' \|\| sudo -n systemctl restart '<app>' \|\| true` |
| `docker` | 可选，省略时用 target 名 | `docker restart '<app>' \|\| docker compose up -d --no-build \|\| true` |

优先级：显式 `restart:` > `service:` > runtime 预设。`service` 与 `restart` 同时写会报 `PIPE_INVALID`；`runtime` 不在上表、`app` 缺失（node/python/php）或含非法字符、`keep` 非正整数、`path` 不是绝对路径、`onHostFailure` 不是 `stop`/`continue` 都会报 `PIPE_INVALID` 并指出 target 与字段。

target 字段清单（client 侧照这个渲染）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hosts` | `string[]` | 非空、去重后的主机别名 |
| `path` | `string` | 远端发布根目录，绝对路径，空表示默认 |
| `runtime` | `static\|node\|python\|go\|php\|docker` | 默认 `static` |
| `app` | `string` | 服务名；node/python/php 必填 |
| `onHostFailure` | `stop\|continue` | 默认 `stop` |
| `canary` | `{first,waitSec}` | v0.6 灰度分批；不配则一次 fan-out |
| `keep` | `number` | 保留最近 N 个 release，默认 5 |
| `service` / `restart` | `string` | 二选一，优先于 runtime 预设 |
| `restartCommand` | `string` | 只读派生值：最终会执行的重启命令 |
| `health` | `{http,tries,interval}` | 健康检查 |
| `current` | `string` | 当前软链目标（只读） |
| `active` | `{host,releaseId}[]` | 每台主机当前生效的 release（只读） |

## 环境选择器与生产护栏（v0.5）

`target.hosts` 除了主机别名，还可以写选择器：`env:prod`、`group:api`、`tag:canary`，并且可以和别名混写。解析期只校验语法（`^(env|group|tag):[a-z0-9._-]{1,32}$`），**真正展开发生在部署前**：

1. `/plan`、`/targets` 会顺手展开（读 dsh-remote 的 `/api/plugins/remote/hosts` 与 `/groups`，5 秒缓存），返回里多出 `selectors`、`envs`、`prodHosts`，`/plan` 还有 `willDeployToProd`。
2. 展开成空集合 → `400 PIPE_INVALID`「选择器 env:nope 没有匹配的主机」。
3. 混写保序、重复别名只保留第一次出现。

生产护栏：展开后只要有一台主机 `env === 'prod'`，`/run` 与 `/rollback` 就必须用 `confirm=prod`（而不是 `confirm=1`），否则返回：

```json
{ "ok": false, "error": "target web 包含生产主机（linux26、api1），写操作需要 confirm=prod 二次确认", "code": "PROD_CONFIRM_REQUIRED", "hosts": ["linux26", "api1"] }
```

HTTP 状态是 **409**。面板会把这条错误变成一张生产护栏卡（`.cicd-prod-guard`，列出受影响主机），点「确认发布到生产」才带 `confirm=prod` 重发。`dryRun` 不触发护栏。

部署锁：同一个 target 同时只能有一次真发布，第二笔立刻 `409 DEPLOY_IN_PROGRESS`「target web 已经有一次发布在执行，等它结束后再试」。`dryRun` 不占锁，进程内 Map 在 finally 里释放。

release 记录新增 `env` 列（`SCHEMA_VERSION` 1 → 2，旧库用 `ALTER TABLE` 补列，历史记录 `env` 为空串），`/releases` 支持 `env=` 过滤。

## 项目向导、编辑器与 git 元信息（v2.0-M0）

面板工具条新增「新建」「编辑」两个互斥视图，与「发布」「审计」同级：

- **新建向导**：填项目名 / 目标目录（可选 git 仓库地址 + 分支），选一种脚手架模板（static/node/python/go/bare），`/project-create` 会落盘一份能直接通过 `parsePipe` 的最小 `pipe.yml`（build → release 两段）。配了仓库地址就先 `git clone --depth 1`，克隆失败报 `GIT_CLONE_FAILED` / `GIT_CLONE_TIMEOUT`；目标目录已有 `pipe.yml` 时再建报 `PROJECT_CREATE_FAILED`。项目记进 SQLite 的 `projects` 表（schema v4），下次启动照常列出。
- **编辑器**：`/project-meta` 返回 `pipeSource`，在 textarea 里改；「校验」走 `/validate?source=`（或 `?project=` 校验落盘文件），语法错带行号与错误码；「保存」走 `/pipe-save confirm=1`，校验通过才写盘，写盘后自动刷新目标并清掉旧计划。
- **git 元信息**：项目卡上多一行 `分支 · 提交 · tag · 已改动`（来自 `/project-meta` 的同步 `readGitMeta`）；运行前从 git 回填 `branch`/`commit_sha` 到 run 记录，`when: branch/tag` 判断有据可依。git 不可用或仓库损坏时一律退化为空值，不崩面板、不阻断流水线。

新增 4 个工具（`cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save`）与 4 条路由（`/project-meta` `/project-create` `/validate` `/pipe-save`），路由契约与既有资源一致（读只要求同源，写额外要 `x-dsh-cicd` 头 + `confirm=1`，并拒绝未知查询参数）。

## 触发、实时日志、取消与 DORA（v2.0-M1）

三种触发方式并存，手动永远可用：

- **入站 webhook（git push）**：`POST`-等效的 GET 前缀路由 `/api/plugins/cicd/hooks/<project>`，查询参数 `ref`（必填，如 `refs/heads/main`）、`sha`、`event`、`token`（也可放 `x-cicd-token` 头）、`confirm`。`triggers.push.branches`/`tags` 用 glob 匹配 ref（`*` 跨 `/`）；命中分支时先异步 `fetch`，若当前工作区正停在该分支再尝试快进，然后写入一次 `trigger='push'` 的运行并立刻返回 202 + `runId`。不命中的 ref 返回 200 `{ok:true,skipped:true}`，不产生运行记录。鉴权：pipe 里没配 `triggers.push` 或没配 `secret` → 403 `WEBHOOK_DISABLED`；token 不匹配（sha256 + 定长比较）→ 401 `WEBHOOK_UNAUTHORIZED`。因为请求可能来自 GitHub/GitLab，这条路由**不要求同源**，身份只靠 token。
- **cron 调度**：`triggers.schedule` 每项是 5 字段 cron + 可选 target。调度器按 `tickSec` 对齐检查，用 `minuteKey`（`YYYY-MM-DDTHH:mm`）去重，落盘 `scheduler-state.json`，进程重启后同一分钟不会重复触发。
- **git push 轮询**：`pollSec > 0` 时周期性 `git fetch` + 读 `refs/remotes/origin/*`，首次只建基线（不会因为存量分支狂发），之后某个分支 sha 变化或基线后新出现的分支才触发 `trigger='push'` 的运行；同一项目串行，不会叠跑。

实时日志：`ws://<host>/api/plugins/cicd/log-ws?runId=<id>`（`registerUpgrade`，与 HTTP 同端口）。连接后先收到 `{type:'snapshot',runId,truncated,lines}`，随后是逐行 `{type:'line',stageId,index,line}`，结束收到 `{type:'end',status}` 后服务端主动关闭。运行已结束或不在内存 hub 里时回退读 `logs/<runId>.log` 尾部 2000 行再发 `end`；`runId` 缺失 400、未知运行 404。hub 每 run 保留最近 5000 行。

取消：`cicd_cancel` 工具或 `/cancel?runId=&confirm=1`。运行中取消 → `AbortController.abort()`，当前步骤整棵进程树被杀（`taskkill /T /F`），运行记录写 `status='canceled'`、`error='已取消'`；对已结束/不存在的运行分别返回 `RUN_NOT_ACTIVE` / `RUN_NOT_FOUND`（HTTP 409 / 404）。取消是幂等的，重复调用返回 `canceling`。

DORA 四项指标（`cicd_dora` 工具、`/dora` 路由，默认最近 30 天，可传 `days`）：部署频率（按成功运行/天，评 elite/high/medium/low）、变更前置时间（`finished_at - git 提交时间`，中位数）、变更失败率（failed+canceled / 全部非 dryRun 运行）、MTTR（同 project+target 失败到下一次成功的平均间隔）。`dryRun` 与未结束的运行一律排除在指标外，`series` 给出最近最多 60 天的每日 `{deployments,failures,canceled}` 以便画趋势。

新增 3 个工具（`cicd_cancel` / `cicd_dora` / `cicd_triggers`）与 4 条路由（`/cancel` `/dora` `/triggers` + prefix `/hooks/<project>`）加 1 条 WebSocket upgrade（`/log-ws`）。调度器在 `apply()` 里随插件启动，`dispose()` 会 `stop()` 定时器并释放 hub。

## 工具

`cicd_projects` / `cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save` / `cicd_plan` / `cicd_run`（`dryRun`、`stage`、`confirm`、`runner`）/ `cicd_status` / `cicd_logs` / `cicd_releases`（可按 `host` 过滤）/ `cicd_rollback`（可选 `host`）/ `cicd_targets`（含 runtime/app/onHostFailure/keep/restartCommand 与每台 active）/ `cicd_cancel`（`runId`）/ `cicd_dora`（`project`、`days`）/ `cicd_triggers`（`project`，返回 triggers 摘要、webhook URL 与调度器快照）/ `cicd_runners`（列出已注册 runner：labels、容量、在线状态、在跑任务数）/ `cicd_approve`（`runId`、`decision`、`resolvedBy`）/ `cicd_secrets`（`project`、`scope`、`name`、`value`）/ `cicd_environments`（`project`）/ `cicd_rbac`（`user`、`role`、`projects`、`ttlSec`、`token`、`action`）。

## HTTP 路由（GET + resource，另加 1 条 prefix 与 1 条 upgrade）

`/api/plugins/cicd/{projects,project-meta,project-create,validate,pipe-save,plan,run,runs,log,releases,rollback,targets,operations,notify-test,cancel,dora,triggers,runner-register,runner-poll,runner-result,runner-log,runners,approve,approvals,secrets,environments,rbac}` 共 28 条精确路由；`run` 支持可选 `runner` 参数指定构建主机；`runner-*` 五条是远端 runner 拉取式协议的入口（register 带 join token、poll 兼心跳、result 回报幂等、log 逐行推送），**不校验同源**（跨机调用），靠 join token 鉴权；`runners` 要求同源。另外两条特殊入口：prefix 路由 `/hooks/<project>`（入站 webhook，靠 token 鉴权、不校验同源）与 upgrade `/log-ws?runId=`（实时日志）。

## 远端 runner（v2.0-M2）

构建步骤默认在本机跑；`pipe.yml` 配了 `targets` 但机器没装 Node 时，可以把构建步骤丢给一台注册过的远端 runner：

1. **注册**：远端机器跑 `node bin/runner.mjs --server https://host:port --runner build-01 --labels node,builder --join-token <secret>`，走 `/runner-register`（join token 校验，sha256 定长比较）。
2. **拉取式协议**：runner 轮询 `/runner-poll` 领任务（兼心跳，15s 一次）；宿主侧 `cicd_run` 带 `runner=build-01` 时，构建步骤经 `TaskBroker` 派发到该 runner，结果走 `/runner-result` 回报（幂等：`resolve` 只认第一次），日志走 `/runner-log` 逐行推（丢行可接受，result 是关键）。
3. **journal 幂等 / 断电续跑**：runner 在本地 `journal.jsonl` 记 `{taskId, attempt, status, exitCode}`，重启后 `status=success` 的任务跳过不重跑，未完成任务 `attempt+1` 重跑——宿主侧的 `resolve` 幂等保证同一 taskId 重复回报不改变状态。
4. **自签 TLS**：`--ca <file>` 指定 CA（undici `setGlobalDispatcher`），`--insecure` 跳过证书校验（仅限内网调试）。
5. **UI**：面板工具条在「目标」后加「构建主机」下拉（本机 / 已注册 runner，离线标 `(离线)`），选中后 `cicd_run` 自动带 `runner` 参数。
6. **取消**：宿主 `cicd_cancel` 对远端运行调 `broker.cancelAll(runnerId)`，runner 端 `cancelSignal` 杀子进程树。

## 发布策略（v2.0-M3）

`pipe.yml` 的 target 可配 `strategy`，把发布从「串行 fan-out + 2 批灰度」升级为五策略引擎：

```yaml
targets:
  prod:
    hosts: [h1, h2, h3, h4, h5]
    path: /srv/app
    runtime: static
    strategy:
      type: rolling        # serial / parallel / rolling / canary / blue-green
      batch: 2             # rolling：每批台数（默认 ceil(hosts/2)）
      waitSec: 30          # rolling/canary/blue-green：批间等待秒数（默认 30）
      onHostFailure: stop  # stop（默认）/ continue
```

| 策略 | 语义 | 备注 |
|---|---|---|
| `serial` | 逐台部署，一台失败即停 | 默认（无 `strategy` 字段时退化） |
| `parallel` | 所有主机并发部署 | 失败按 `onHostFailure` 决定 |
| `rolling` | 每批 N 台，批间等 `waitSec` | 单台失败按策略停/跳；批内串行 |
| `canary` | 先 `first` 台 + 观察窗口 + 自动扩量 | 等价现有 2 批灰度，`first` 可配；首批失败永远停 |
| `blue-green` | 起一套完整新实例，切流量后旧实例退役 | 任一台失败 → 全部自动回退到 previous |

- **策略锁**：滚动中 `onStrategyProgress` 回调记录批次进度（batch index + 已完成主机），宿主侧写 `store.operations`（`action:'strategy-progress'`）；cancel 后重跑时可按 lastBatch 续。
- **兼容**：不配 `strategy` 字段时，按现有 `canary.first/waitSec` 退化；`canary` 字段仍可用。
- 回滚仍是一键 `current` 切回（`cicd_rollback`）。

## 环境与审批（v2.0-M4）

`pipe.yml` 的 target 自动映射为 environment（dev < staging < prod 顺序，`lib/environments.js`）：

- **prod 默认保护**：`targetName === 'prod'`（不区分大小写）→ `protected: true` + `approvalRequired: true`；也可显式配 `protected: true` / `approvalRequired: true` 覆盖。
- **审批门（block gate）**：`approvalRequired` 的 target 在 `executeRun` 里停在「待审批」，抛 `APPROVAL_REQUIRED`（HTTP 409）；面板/`cicd_approve` 点「通过」（`decision=approve`）后重跑 `executeRun`，审批通过 → `approval-resolved` 审计 → 仍走 `confirm=prod` 护栏（双重确认）。拒绝 → `approval-rejected`。
- **secrets**：`cicd_secrets` 工具 / `/secrets` 路由设置/列出 secret；DB 只存 ref，载荷落 `workDir/.secrets.json`（0600，原子写）；`pipe.yml` 里 `${{SECRET_NAME}}` 插值时 `refsForInterpolate` 自动注入，不落明文到日志/DB。
- **晋升路径**：`cicd_environments` 工具 / `/environments` 路由列出环境 + `promotionPath`（dev → staging → prod）。
- **制品缓存**：本次未实现（`lib/cache.js` 留待后续）；现有 `artifacts` 表已记录每次 run 的产物，`keep` 清理策略复用 deploy.js 的 `cleanupReleases`。

## RBAC（v2.0-M5，远端服务模式）

server 模式启用三角色 RBAC（`lib/rbac.js`，单机模式仍无角色）：

| 角色 | 读 | 写 | 管理 |
|---|---|---|---|
| `viewer` | ✅ | ❌ | ❌ |
| `operator` | ✅ | 项目范围内 | ❌ |
| `admin` | ✅ | 全量 | ✅ |

- **token 签发**：`cicd_rbac` 工具 / `/rbac` 路由（`user=alice&role=admin&ttlSec=3600`）→ 返回 `rbac-xxxxxxxx`（sha256 摘要落盘，`workDir/.rbac.json` 0600）；token 短 TTL，过期自动拒（`TOKEN_EXPIRED`）。
- **权限检查**：`canWrite(user, project)` 按角色 + 项目范围（`*` 全量或逗号串）；`canAdmin(user)` 仅 admin。
- **审计**：所有 token 签发/吊销/写操作落审计时间线（最近 500 条），`action=audit` 导出全部（按时间正序）。
- **吊销**：`action=revoke&user=alice` 立即失效该用户所有 token。

## 安全边界

- 不解析任意 YAML：只认 map/sequence/内联数组/标量，块标量（`|`、`>`）与 flow map 直接报错。
- 构建命令只来自 `pipe.yml` 的 `run`，在项目目录里以 shell 执行；`dryRun` 只打印计划。
- 发布不新增凭据：全部经 dsh-remote 的回环路由，上传走 8KB 分块，单文件上限 64MB。
- webhook 只发到配置里写死的 http(s) URL，payload 不含任何凭据；失败只记审计，不重试、不阻塞发布。
- 入站 webhook 不信任来源：必须 pipe 里显式配 `triggers.push.secret`，token 走 sha256 定长比较；没配 secret 的连接一律 403，n 次失败不会触发任何构建。
- 实时日志 WebSocket 与 HTTP 同端口、同源策略：鉴权沿用 DSH webserver 的会话边界，只按 `runId` 推送该次运行的日志（日志本身已在磁盘上，不是新暴露面）。
- 调度触发的生产发布默认被生产护栏拦住（`allowProd: false`），要显式打开才会自动带 `confirm=prod`。
- 远端 runner 的 `runner-*` 路由不校验同源（跨机调用），靠 join token（sha256 定长比较）鉴权；`resolve` 幂等保证同一 taskId 重复回报不改变状态；日志丢行可接受，result 是关键。
- `bin/runner.mjs` 的 `--insecure` 仅限内网调试，生产建议 `--ca <file>` 指定 CA。
- secrets 载荷落 `workDir/.secrets.json`（0600），DB 只存 ref；`refsForInterpolate` 注入后不落明文到日志/DB。
- 审批门（block gate）：prod 默认停在「待审批」，`/approve` 路由解除阻塞后仍走 `confirm=prod` 护栏（双重确认）；审批记录落 `store.operations`（`action='approval-request/approval-resolved/approval-rejected'`）。
- RBAC token 落 `workDir/.rbac.json`（0600），DB 只存 sha256 摘要；token 短 TTL（默认 3600s），过期自动拒；写操作全审计（最近 500 条），`action=audit` 导出全部。
- 日志读取有 `maxLogBytes` 截断；`runId` 做了字符白名单校验。

## 自检

```bash
node packages/dsh-cicd/test/smoke.mjs   # 73 项：解析/计划/存储/执行/发布/灰度/通知/审计/路由/选择器/护栏/锁/迁移/向导/编辑器/脚手架/cron/triggers/scheduler/webhook/log-ws/cancel/DORA/executor/broker/joinToken/strategy(5 策略+策略锁)/environments/approvalGate/secrets/RBAC
node test/mount.mjs                     # 全包挂载闸门（本包 20 工具 / 28 路由）
```

不连真实 SSH：remote 用假 fetch，deploy 用记录命令的假 remote。

## 冷启动路由注册与惰性 remote（v0.6.1）

与 dsh-remote 同病：冷启动时 `webServer` 晚于插件 `apply()`，v0.6.0 起在 apply 里同步 `ctx.get('webServer')` 拿不到服务 → 整包路由 404。v0.6.1 起路由注册挂到 `ctx.inject(['webServer'], …)`（就绪后补注册全部路由，v2.0-M5 起是 28 条精确路由 + 1 条 prefix + 1 条 upgrade）；`remote()` 改惰性解析——`options.remoteBase` 为空时首次调用从 `ctx.get('webServer').port` 取，取不到返回未缓存客户端（保持可重试的 `REMOTE_UNAVAILABLE`）。smoke 有冷启动回归（0 路由 → 28 条精确路由 + 1 条 prefix + 1 条 upgrade + remote base 断言）。

## 实战踩到的坑（v0.2）

真机跑通（linux26 + dsh-remote）时踩到 5 个坑，都已修并进 smoke：

1. **`pkill -f 'http.server 8099'` 会把自己杀掉**：`restart` 命令自身的命令行也含这个字符串，pkill 匹配到它 → exec 返回 exit 空、服务根本没起来。改成按端口杀：`fuser -k 8099/tcp`。
2. **多个产物命中时要取最新的**：`dist/app-*.tgz` 命中多个旧包时，按字母序取第一个会把上一次的包部署上去。现在按 mtime 取最新。
3. **dsh-remote 的 exec 回包是 `{ok, result}`**：健康检查读 `exitCode` 前必须摊平 `result`，否则永远判失败（页面明明 200）。
4. **健康检查的重试等待不能 `unref()`**：脚本/短命进程会在等待期间把事件循环跑空（`unsettled top-level await`）。
5. **`RELEASE_ID` 要在 plan 之前生成**：runId 现在先生成，`${{RELEASE_ID}}` 才插得进产物名（之前一直是 `dist/app-.tgz`）。

另外：首次部署健康检查失败会把 `current` 撤掉（没有 previous 可回滚，不把坏版本留在线上）。

## 真机实测（linux26 / python3 http.server）

- 首次部署：build 144ms + deploy 2326ms，`current -> releases/<runId>`，`curl` 拿到真实页面，`revisions.log` 追加一行。
- 二次部署（改了内容）：页面新增标记出现 → 回滚到上一条：标记消失、`current` 指回旧 release、`revisions.log` 追加 `rollback:<id>`；再滚回去标记又出现。
- 回滚一个被 `keep` 清掉的 release → 404 `RELEASE_NOT_FOUND`，不动线上。
