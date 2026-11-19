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
| **v3.0-P0** | **Security baseline**: local accounts + sessions + API tokens (`lib/auth.js`), `can()` policy with default-deny (`lib/policy.js`), deploy locks persisted in SQLite (`lib/locks.js`), hash-chained audit log (`lib/audit.js`), runner registry with revoke (`lib/runners.js`), approval bound to artifact digest + TTL + no self-approval; UI gets hash routing, left nav, breadcrumb and deep links. DSL unchanged. |
| **v3.0-P1** | **Execution core**: DSL v2 (`stages[].jobs[]` + `needs` + `matrix`) normalised into a job graph (`lib/model.js`), executed as a topological DAG with a concurrency pool (default 4, `jobs.concurrency`) by `lib/jobs.js`, a sandboxed expression evaluator that never calls `eval` (`lib/expr.js`), T0/T1/T2 evaluation tiers, per-job log shards, and a `pipe.yml` snapshot + sha256 stored on every run. v1 `pipe.yml` files keep working untouched. |
| **v3.0-P5** | **Artifact CAS**: bytes live in a content-addressed store (`<workDir>/artifacts/blobs/sha256/<aa>/<hex>`), written through a temp file and committed with an atomic `rename`, so a half-written blob can never appear. Every upload re-hashes the bytes and rejects a mismatched declared digest (one flipped byte is a `409`, not a silent success). `GET /artifacts?digest=…` serves single-range requests with `content-digest` / `ETag` / immutable caching; `POST action=tag` moves a pointer without copying bytes; `gc` refuses to delete anything a tag or a release still references and defaults to dry-run. Metadata lands in SQLite (`artifact_blobs`, `artifact_refs`, schema v10); the bytes never do. Upload takes a **local path** only — the build artifact is already on the build host, and opening HTTP writes would widen the auth surface from same-origin to publicly writable. |
| **v3.0-P5-5** | **Promotion = a pointer, not a copy**: `GET/POST /api/plugins/cicd/promotions` (or `cicd_promotions`) records that *these bytes* were promoted to *that environment* — no bytes move, and the digest cannot drift. A deploy to a protected environment (`prod`, or anything `protected: true`) must name a digest that was promoted there, judged **per host on that host's own env** and against the target's owning project, so "run project A's target that happens to live in B's prod" is closed too. Rollback checks the other side: the bytes on the host are re-hashed and compared with the manifest's digest before the symlink moves. |
| **v3.0-P5-4** | **OCI registry (`/v2/`)**: `docker push` / `docker pull` work against the plugin itself. A manifest is just another artifact — its bytes are stored in the same CAS, a tag is `refs/<repo>/<tag>`, and a layer is a blob by digest — so pulling an image, downloading a build artifact and rolling back a release all read the same bytes with the same auth and the same GC retention set. Auth is a 15-minute HS256 bearer token whose scope is baked in at issue time (`repository:<name>:pull` cannot push), issued from the host session at `/v2/token`. A manifest that references an uploaded-missing layer is rejected with `OCI_MANIFEST_BLOB_UNKNOWN` instead of being stored and failing at deploy time; re-tagging moves the pointer while the previous digest stays pullable, which is exactly what a container rollback needs. `DELETE /manifests/<tag>` drops the tag only — bytes go through GC. |
| **v3.0-P5-3** | **Read-only package repos (Maven / npm / PyPI)**: `GET /repository/maven/<groupPath>/<artifact>/<version>/<file>`, `GET /repository/npm/<pkg>` (packument) and `GET /simple/<project>/` (PEP 503 HTML, or PEP 691 JSON when the client asks for it via `Accept`) serve straight out of the CAS, so a published coordinate and an OCI layer are the same bytes under the same auth and the same GC retention set. `maven-metadata.xml` and packuments are **generated from `artifact_packages`** (schema v11) rather than stored, and versions are ordered semantically — `1.10.0` after `1.9.0`, and `2.0.0-rc1` never wins `latest` over `2.0.0`. Coordinates are immutable: re-publishing the same one with different bytes is `PACKAGE_DUPLICATE`; the same bytes again is idempotent. npm `dist.integrity` is the SRI computed once at publish time and kept in `meta`. These routes are **read-only** — any non-GET/HEAD is `405 REGISTRY_READ_ONLY`; writes go through `cicd_artifacts upload` + `publish`. |
| **v3.0-P3** | **Deploy modes**: `mode: container` targets get their own Actuator (`lib/actuator/container.js`) on the same four-phase transaction as native — stage pulls `<image>@sha256:…` (a tag is refused with `CONTAINER_IMAGE_INVALID`, because rolling back to a tag rolls back to whatever it points at today), activate starts one container per instance with `-p 0:<port>` and reads the host port back from `docker port` (no published port = `CONTAINER_PORT_UNKNOWN` and `current` is never switched), verify runs the same L1/L2/L3 probes, and rollback re-pulls the digest recorded in the **previous release's own manifest** rather than the mutable tag. Compensation and rollback share one `revert()`, so there is only one code path that can move a target backwards. |
| **v3.0-P2** | **Toolchains & actions**: `toolchain:` declares vendor+version only (never a URL) and the installer resolves → downloads → checksums → extracts into its own store, then injects a **whitelisted** env into the child process (the host's `JAVA_HOME` / `NODE_OPTIONS` never leak in, and the host itself is never modified). Lock file + `frozen` + offline mode, Maven `toolchains.xml` and Gradle `installations.paths` so the daemon uses the same JDK. `uses:` executes seven built-in actions (checkout / toolchain / cache / collect / deploy / verify / notify) — **no external actions**, and an unknown action or unknown `with` key is a hard failure, not a silent skip. |

### Layout

| File | Responsibility |
| --- | --- |
| `index.js` | Host entry: 29 tools + 35 exact GET routes + 4 prefix routes (webhook, OCI `/v2`, Maven/npm `/repository`, PyPI `/simple`) + 1 WebSocket upgrade (live logs); assembles the runtime |
| `lib/pipe.js` | YAML-subset parser (v1 and v2), `${{VAR}}` interpolation, restricted `when` expressions, glob, `buildStep()` normalisation shared by the plan and the DAG runner, `triggers` normalisation |
| `lib/runner.js` | Executor with two paths sharing one step implementation: v1 walks stages sequentially, v2 (`stages[].jobs[]`) runs the job DAG through `lib/jobs.js`. Writes the merged log plus one shard per job, redacts secrets before every sink, supports external `runId`, `AbortSignal` cancel, live-log hub |
| `lib/db.js` | SQLite open / DDL / migration: runs, steps, artifacts, releases, operations, projects, deploy_locks, audit_events, users, memberships, api_tokens, sessions, approvals, runners, artifact_blobs, artifact_refs + indexes; `PRAGMA user_version` tracks schema (**v10**: v9 added release rollback columns, v10 added the two artifact tables; **v8**: v7 added `steps.job_id` to the primary key, v8 added `runs.config_snapshot` / `config_hash`; both migrate existing databases in place) |
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
| `lib/rbac.js` | Legacy file-backed RBAC (server mode, v2.0-M5): 3 roles + project scope + short-TTL tokens; payload in `workDir/.rbac.json` (0600). **Superseded by `lib/auth.js` + `lib/policy.js` in v3.0-P0** — it no longer participates in any decision, `/rbac` is kept for reading old tokens only |
| `lib/auth.js` | v3.0-P0 identity: local accounts (scrypt, pure JS — no native build), DB-backed sessions (HttpOnly cookie) and API tokens (`cicd_<id>_<secret>`, sha256 only, TTL + revoke), project-scoped memberships. **Bootstrap**: while the `users` table is empty every request is `owner`, so a fresh install is never locked out |
| `lib/policy.js` | v3.0-P0 authorisation: `can(actor, action, resource) → {allow, reason, policyId}`, 17 actions × 4 roles (viewer / operator / admin / owner), **default deny**, never throws |
| `lib/audit.js` | v3.0-P0 audit: append-only `audit_events` with a sha256 hash chain (`prev_hash` + canonical record); `verify()` walks the chain and reports the first broken row (`kind: prev_hash | hash`) |
| `lib/locks.js` | v3.0-P0 deploy locks: `deploy_locks` table (survives restarts), TTL + heartbeat, `release` requires matching runId/owner (no unconditional release), `forceRelease` is audited |
| `lib/promotions.js` | v3.0-P5-5 environment promotion: a promotion is one row plus a pointer, never a copy of the bytes. `isPromoted()` reads the `promotions` table rather than "this digest once ran here", so a hand-run prod deploy is not a licence. Two reads must hold before a protected host is touched: the digest is in the CAS *and* `verify()` still agrees with it. |
| `lib/artifacts.js` | v3.0-P5-1 content-addressed store: streaming sha256 → temp file → atomic `rename` (`blobs/sha256/<aa>/<hex>`), single-range reads, `verify()` recomputes from disk, tag pointers in `refs/<owner>/<name>.json`, `gc()` defaults to dry-run and never touches a blob a pointer or a release still names |
| `lib/packages.js` | v3.0-P5-3 read-only package repos: coordinate normalization and immutability, semantic version ordering (`2.0.0` > `2.0.0-rc1`), and the three generated index formats — `maven-metadata.xml`, npm packument (tarball → CAS, `dist.integrity` SRI), PEP 503 HTML / PEP 691 JSON. `resolve()` returns either generated bytes or a blob digest, so the route layer never guesses |
| `lib/oci.js` | v3.0-P5-4 OCI Distribution v2 primitives: repository/digest/reference parsing (uppercase is an error, never silently lowercased), canonical JSON so a manifest digest is stable, media-type validation, scoped HS256 tokens (15-min, scope baked in), and in-memory upload sessions whose temp files land in the CAS `tmp/` |
| `lib/runners.js` | v3.0-P0 runner registry: DB-backed, online is derived (3 × heartbeat), revoke is persistent and immediate (a revoked runner never resurrects on re-register) |
| `lib/expr.js` | v3.0-P1 expression evaluator: hand-written lexer + recursive-descent parser, **no `eval` / `new Function`** (a `pipe.yml` is whatever a pull request says it is — a real JS evaluator would hand arbitrary code execution on the build host to anyone who can submit one). T0/T1/T2 root whitelists and a fixed function list |
| `lib/model.js` | v3.0-P1 model normalisation: v1 stages become `<stage>-main` jobs (each `deploy` step becomes its own `kind:'deploy'` job), v2 `stages[].jobs[]` expands as written, `matrix` expands to `job[key=value,...]` (64 instances / 3 dimensions max), `resolveJobGraph()` accepts job id / matrix base name / stage id in `needs` and rewrites them to real ids |
| `lib/jobs.js` | v3.0-P1 DAG scheduler: `scheduleJobs({jobs, concurrency, signal, runJob, onSkip})` runs ready jobs through a pool, propagates failure **and** skip downstream (skipped upstream is not "green"), and honours `allow_failure` |
| `lib/toolchain.js` | v3.0-P2 toolchains: `parseSpec` / `pickVersion` / providers (Adoptium, Maven, Gradle, Node, Go; PHP has no portable build), `mkdir` cross-process lock + in-process inflight reuse, checksum by algorithm (Maven publishes sha512, Node publishes sha256), `envFor()` whitelist, `assertVersions()`. **A `pipe.yml` may only say `vendor+version`** — a URL there would let anyone who can submit a PR execute an arbitrary binary on the build host |
| `lib/actions.js` | v3.0-P2 `uses:` actions: seven built-ins, each declaring the capability it needs; unknown action / unknown `with` key / missing capability are all hard failures. There is deliberately no way to reference an external action |
| `lib/cache.js` | v3.0-P2 build cache: `<workDir>/cache/entries/<sha256(project,key)>/{meta.json,files/}`, exact key then `restore_keys` prefix match, atomic staging + rename. `paths` must be relative to the project or start with `~/` — an absolute path is rejected (otherwise `paths: ["/etc"]` packs the whole host) |
| `lib/actuator/container.js` | v3.0-P3 container Actuator: digest-only image references, `docker pull` → `docker run -p 0:<port>` → `docker port` → `ln -sfn current`, L1 (`docker ps` + `ss`) / L2 (per-instance HTTP probe) / L3 (observation window), `revert()` re-pulls the previous manifest's digest with `switchCurrent: false`, manifest records `artifact.reference` and `instances[].containerId` |
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

`cicd_projects` / `cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save` / `cicd_plan` / `cicd_run` (`dryRun`, `stage`, `confirm`, `runner`, `approvalId`) / `cicd_status` / `cicd_logs` / `cicd_releases` (filter by `host`) / `cicd_rollback` (optional `host`) / `cicd_targets` (runtime/app/onHostFailure/keep/restartCommand + per-host active) / `cicd_cancel` (`runId`) / `cicd_dora` (`project`, `days`) / `cicd_triggers` (`project`, returns the triggers summary, webhook URL and scheduler snapshot) / `cicd_runners` (list + `action=revoke`; labels, capacity, online state, revoked state, active task count) / `cicd_approve` (`approvalId` or `runId`, `decision`, `reason`, `resolvedBy`) / `cicd_secrets` (`project`, `scope`, `name`, `value`) / `cicd_environments` (`project`) / `cicd_rbac` (`user`, `role`, `projects`, `ttlSec`, `token`, `action` — legacy) / **`cicd_auth`** (`action=me|login|logout`) / **`cicd_users`** (`action=list|create|get|set-password|set-role|remove-role`) / **`cicd_tokens`** (`action=list|create|revoke`) / **`cicd_audit`** (`action=list|verify`) / **`cicd_locks`** (`action=list|release`).

### HTTP routes (GET + resource, plus 1 prefix and 1 upgrade)

`/api/plugins/cicd/{projects,project-meta,project-create,validate,pipe-save,plan,run,runs,log,releases,rollback,targets,operations,notify-test,cancel,dora,triggers,runner-register,runner-poll,runner-result,runner-log,runners,approve,approvals,secrets,environments,rbac,auth,users,tokens,audit,locks,toolchain}` — 33 exact routes; `run` takes an optional `runner` param to pick the build host and an optional `approvalId` to consume an approved request; the five `runner-*` routes are the remote-runner pull protocol (register carries the join token, poll doubles as heartbeat, result is idempotent, log pushes line by line) and **do not check same-origin** (cross-machine calls), authenticated by the join token; `runners` requires same-origin. Two special entries: the prefix route `/hooks/<project>` (inbound webhook, token-authenticated, no same-origin check) and the upgrade `/log-ws?runId=` (live logs).

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
- **Build cache**: `uses: cache` restores before the build and saves in a job-end finaliser (at the point the step runs, `dist/` is still empty — the same reason GitHub has post steps). Exact key first, then `restore_keys` prefix. `paths` must be project-relative or start with `~/`; absolute paths are rejected. The `artifacts` table still records each run's artifacts, and `keep` cleanup reuses `cleanupReleases` from deploy.js. A content-addressed artifact store (immutable digests, dedupe, promotion between environments) is P5, not this.

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

### Identity, policy, locks & audit (v3.0-P0)

The v2 line had write routes guarded by nothing but "same-origin + a header + `confirm=1`", an in-process `Map` for deploy locks, an audit timeline capped at 500 entries with no integrity check, and an approval gate that forgot everything on restart. v3.0-P0 closes those four holes without touching the DSL.

**Identities (`lib/auth.js`).** Three credential kinds, checked in this order: API token → session cookie → bootstrap.

- **Accounts are local**: `POST /users?action=create` (or `cicd_users`) with `email` + `password`; hashes are scrypt (`N=2^15, r=8, p=1`, pure JS — no native build, no argon2 dependency). Passwords under 8 chars are rejected.
- **Sessions**: `/auth?action=login` returns an HttpOnly `dsh_cicd_session` cookie (`SameSite=Strict`) with a 12 h TTL; `/auth?action=logout` clears it. The DB keeps a sha256 digest only.
- **API tokens**: `/tokens?action=create&userId=…&ttlSec=…` returns `cicd_<id>_<secret>` **once** — only the digest is stored. Send it as `Authorization: Bearer …` or `x-dsh-cicd-token: …`. Expired → `TOKEN_EXPIRED`, revoked → `TOKEN_REVOKED`.
- **Bootstrap**: while the `users` table is empty every request is treated as `owner`/`authMethod=bootstrap`, so a fresh install is never locked out. Create the first account with `role=owner` — `admin` is not allowed to manage members, so it cannot promote itself afterwards. The moment one user exists, anonymous access stops (`AUTH_REQUIRED`).

**Authorisation (`lib/policy.js`).** Every write route funnels through `can(actor, action, resource)`, which returns `{allow, reason, policyId}` and **defaults to deny**: unknown action, missing actor, disabled actor, token scope violation, missing membership, or an insufficient role all deny. 17 actions × 4 roles:

| Role | Can |
|---|---|
| `viewer` | read |
| `operator` | + run / cancel / retry / deploy-nonprod / rollback-nonprod / approve |
| `admin` | + edit-config / manage-secret / reveal-secret / deploy-prod / rollback-prod / manage-runner / manage-project / audit-read |
| `owner` | + manage-members / manage-env |

`prod` (or `protected: true`) additionally requires `admin` for deploy/rollback/env actions, even inside a granted project. Roles are granted per project; nothing is inherited implicitly.

**Deploy locks (`lib/locks.js`).** Locks live in the `deploy_locks` table, so "one deploy per target" now survives a restart. Each lock carries a TTL (default 1800 s) and is heartbeat-refreshed for a third of it while the run is alive, so a crashed host frees the target without manual intervention. `release()` requires the matching runId or owner — an unconditional release would let one run delete another's lock. `forceRelease` is admin-only and audited.

**Audit (`lib/audit.js`).** `audit_events` is append-only, each row carrying `prev_hash` and `hash = sha256(prev_hash + canonical(record))`. `cicd_audit verify` (`/audit?action=verify`) walks the chain and reports the first broken row (`kind: prev_hash` when the link is broken, `kind: hash` when a field was edited in place). Both allow and deny decisions are recorded — a denied write is exactly the signal you want when reviewing an incident.

**Approvals.** Requests are rows, not memory: `approvals` stores the target, the requester, an expiry (default 4 h) and the **artifact digest** the approval is for. Three rules make it safe: the approver cannot be the requester (`SELF_APPROVAL_FORBIDDEN`), the approval is consumed exactly once (`APPROVAL_CONSUMED` on the second use), and the digest must match (`APPROVAL_DIGEST_MISMATCH`). The digest is computed from the deployment's inputs (`project + target + commit + pipeline + stage`) because the artifact does not exist yet when approval is requested; the same commit recomputes the same digest, a different commit does not. Expired requests are reaped lazily: `failed(approval_timeout)` on the run plus `approval.timeout` in the audit.

**Runners.** Registration is a DB row, `online` is derived from `last_seen_at` (offline after 3 × heartbeat), and **revoke is persistent and immediate** — a revoked runner cannot claim tasks, and its late results are dropped.

**UI (P0-6/P0-7).** The panel gained hash routing, so views are addressable and survive a refresh:

```
#/projects/:project[/runs/:runId | /releases | /approvals | /pipeline | /new | /runners | /secrets | /rbac | /audit][?target=&step=&line=]
```

Hash (not `history.pushState`) because the panel is mounted inside the host page: rewriting the host path makes the host 404 on refresh, while a fragment keeps the host's route intact and lets the panel restore its own view. The 13 equally-weighted toolbar buttons became a left nav (pipeline / config / admin), the toolbar keeps only project, target, build host, plan, dry run, run, refresh; a breadcrumb shows `project › view › run` with a copy-link button; `?line=1204` highlights and scrolls to that log line.

### DSL v2 execution core (v3.0-P1)

v1 was "one stage = one sequential list of steps": a stage could not fan out, `needs` did not exist, and every step ran one after another even when nothing forced the order. v3.0-P1 adds `stages[].jobs[]` and executes it as a DAG. **v1 files are untouched** — the normaliser turns each v1 stage into a single `<stage>-main` job, so the old behaviour falls out of the new engine instead of being a second code path kept alive by hand.

```yaml
version: 2
stages:
  - id: test
    jobs:
      - id: unit
        matrix: { java: ["17", "21"] }
        steps:
          - run: mvn -B verify
      - id: lint
        steps:
          - run: mvn -B spotless:check
  - id: ship
    jobs:
      - id: gate
        needs: [unit, lint]        # matrix base name expands to both instances
        steps:
          - run: echo release
      - id: deploy
        needs: [gate]
        steps:
          - deploy: { target: prod }
```

- **Job graph (`lib/model.js`).** A `stage` keeps exactly two jobs: it groups jobs in the UI, and it is the default dependency ("a job without `needs` waits for every job of the previous stage"). The moment any job writes `needs`, ordering belongs to the DAG. `needs` accepts a real job id, a matrix base name (`unit` → every instance), or a stage id / `stage:<id>`; `resolveJobGraph()` rewrites all three to real ids so downstream code never sees a base name. Cycles → `PIPE_CYCLE` with the path (`job 依赖出现环：a → b → a`), unknown ids → `PIPE_UNKNOWN_JOB` with the candidate list.
- **Matrix.** `matrix: {java: [17, 21]}` becomes `unit[java=17]` / `unit[java=21]` (keys sorted, so instance ids are stable). Hard caps: 64 instances, 3 dimensions, `exclude` for exact-match removal — a 5×4×4 matrix is rejected at parse time (`PIPE_MATRIX_TOO_LARGE`) with the actual count in the message, because the alternative is discovering it after 80 agents light up.
- **Scheduler (`lib/jobs.js`).** Ready jobs go through a pool (`jobs.concurrency`, default 4, clamped 1–32). Failure propagates **and so does skip**: a job whose upstream was skipped is skipped, not "green" — GitHub semantics, and the reason `blocksDownstream` treats `skipped` as blocking. `allow_failure: true` stops the propagation for that job.
- **Expressions (`lib/expr.js`).** `when:`, `if:` and `${{ … }}` are evaluated by a hand-written lexer + recursive-descent parser. It deliberately does **not** use `eval` / `new Function`: a `pipe.yml` is whatever a pull request says it is, and a real JS evaluator would hand arbitrary command execution on the build host to anyone who can submit one. `evaluate('process.exit(0)')` returns `PIPE_EXPR`.
- **Evaluation tiers.** T0 (`event` / `branch` / `tag` / `paths` / `ref`) → T1 (adds `vars` / `matrix` / `needs` / `env` / `project` / `target` / `stage`; this is where the job graph is decided) → T2 (adds `secrets` / `steps` / `outputs`; the only tier that runs while a command is being spawned). Referencing `secrets` in a `when:` is a T1 error with the reason spelled out: *T1 results go into run records and logs, which is exactly where a secret must not end up*. `validateExpressions()` runs the same whitelists at parse time, so an illegal expression fails before a single command runs.
- **Config snapshot.** Every run stores the raw `pipe.yml` (`runs.config_snapshot`) plus its sha256 (`config_hash`). Re-runs and retries read the snapshot, not the working tree — otherwise "what exactly did last night's failed run execute" has no answer once someone edits the file.
- **Log shards.** The merged timeline stays (it is what you want when reasoning about ordering), and each job additionally gets `logs/<runId>/<job>.log`. `cicd_logs` / `/log?jobId=` read a shard; brackets and commas in matrix instance ids are replaced with `_` in the filename because `[ ] = ,` are not valid on Windows. The panel's log toolbar gets a "only this job" picker, shown only when there is more than one job (a one-option dropdown is pure noise), and the job layer is rendered between stage and step — otherwise "which of these ran in parallel" is invisible.

**Client.** `timelineRows(stages, jobs)` inserts job rows; a step whose `jobId` matches no job lands in an explicit "（未分组）" block rather than disappearing. `runJobsOf()` prefers the job graph from `/run` (status, duration, needs) and falls back to the shard list from `/log` (id only, status left blank — unknown is rendered as unknown, never as success). Switching runs clears the selected job shard, because a `jobId` from run A does not exist in run B and the host could only answer 404.

### Toolchains & actions (v3.0-P2)

```yaml
version: 2
toolchain:
  java: temurin-17      # vendor + version. Never a URL.
  maven: "3.9.6"
stages:
  - id: build
    jobs:
      - id: compile
        steps:
          - uses: checkout
            with: { fetch_depth: 1 }
          - uses: cache
            with:
              key: m2-${{ vars.JAVA }}
              paths: [ "~/.m2/repository" ]
          - run: mvn -B -DskipTests package
          - uses: collect
            with: { paths: [ "target/*.jar" ], name: app }
```

- **Declarative, not imperative.** `toolchain:` says *what version must exist*, never *where to get it*. The installer resolves (lock file first, then the provider), downloads, verifies, extracts into its own store (`<workDir>/toolchains/store/<lang>/<version>/<platform>`), and only then injects. The host is never modified: no shell rc edits, no global symlinks, no `export`.
- **Whitelisted env (`envFor`).** The child process gets a fresh env built from a passthrough whitelist, with `PATH` prefixed and `JAVA_HOME` / `PYTHONHOME` / `GOROOT` explicitly set or removed. The host's `JAVA_HOME` and `NODE_OPTIONS` must not silently change a build — that is the whole disease this replaces. `GOTOOLCHAIN=local` stops Go from downloading a toolchain of its own and quietly defeating the lock.
- **Checksums by algorithm.** Maven publishes `.sha512`, Node publishes `SHASUMS256.txt`, Adoptium publishes sha256. Verifying only sha256 would have forced us to drop Maven verification, so `parseChecksum()` accepts `sha512:` / `sha256:` / `sha1:` prefixes and bare hex (by length).
- **Locks and offline.** `pipe.lock` is keyed by `lang@spec@platform` and can carry several platforms in one entry, so the same `pipe.yml` builds on a Windows host and a Linux runner. `frozen: true` + a missing entry fails immediately *without asking any index*, which is what makes an air-gapped build reproducible. `offline: true` means "no network", not "no files": a `file:///opt/mirror/...` URL still works, because an internal mirror is exactly what offline builds are for.
- **Version assertion.** After installing, `assertVersions()` runs `java -version` / `mvn -v` / `node --version` / `go version` in the injected env and matches the declared version. "Installed 17 but ran 21" is the hardest class of bug to attribute later, so it fails at the start of the run, not in the artifacts.
- **No external actions.** `uses:` accepts exactly seven names: `checkout`, `toolchain`, `cache`, `collect`, `deploy`, `verify`, `notify`. An unknown name is `ACTION_NOT_FOUND`, an unknown `with` key is `ACTION_INPUT_INVALID`, and a missing capability is `ACTION_UNAVAILABLE`. None of them are skipped: a silently skipped action makes a pipeline look green while having done nothing, which is the worst failure mode there is. Referencing an action from another repository is deliberately impossible — that turns a CI system into an open remote-execution endpoint, and doing it safely needs pinning, auditing and signing that this package does not have. Custom logic goes in `run:`.
- **Checkout never switches branches.** The runner builds in the project directory itself, so a `git checkout` would rewrite the user's working copy and their next `git status` would show changes they never made. `uses: checkout` fetches and initialises submodules, and if `ref` is declared it *verifies* HEAD matches — mismatch is a failure that says exactly why.
- **Cache is restore-then-save.** At the point the step runs, `dist/` is still empty, so saving happens in a finaliser at job end (GitHub's post steps, same reason). Keys are exact first, then `restore_keys` prefix match — an outdated dependency cache beats no cache. `paths` must be relative to the project or start with `~/`: an absolute path is rejected, because `paths: ["/etc"]` would otherwise pack the host into a cache that gets restored into the next project.
- **Capability injection.** Actions do not know where they run; they declare "I need git / toolchain / deployer" and `createActionRuntime()` hands them the real thing. `deploy` is wrapped as a fake step with only a `deploy` field and handed to the existing `deployStep`, so production confirmation, selector expansion, locks, audit and rollback are not re-implemented (and therefore not missed).



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
node packages/dsh-cicd/test/smoke.mjs   # 102 checks: parse/plan/store/run/deploy/canary/notify/audit/routes/selectors/guard/locks/migration/wizard/editor/scaffold/cron/triggers/scheduler/webhook/log-ws/cancel/DORA/executor/broker/joinToken/strategy(5+lock)/environments/approvalGate/secrets/RBAC + v3.0-P0 auth/policy/locks/audit/runners + the 8 acceptance rows of docs/proposals/cicd-v3/08-security-rbac.md §10 + v3.0-P1 expr/model/jobs (v1 normalisation, matrix caps, cycles, pool, skip propagation, cancel, v2 end-to-end, config snapshot, log shards) + v3.0-P2 toolchain (host JDK21 vs declared 17, concurrent jobs on different JDKs, offline+frozen, tampered package, dual-platform lock, cache hit, failure record, Maven/Gradle dual locks) and actions (unknown action/param hard failure, verify retries, checkout refuses to switch branches, cache round-trip + prefix hit + absolute-path rejection, v1 `uses:` end-to-end)
node test/mount.mjs                     # full mount gate (this package: 26 tools / 33 routes)
```

No real SSH: the tests use a fake fetch for remote and a command-recording fake remote for deploy.

### Cold-start route registration & lazy remote (v0.6.1)

Same disease as dsh-remote: at cold start `webServer` comes up after the plugin's `apply()`, so a synchronous `ctx.get('webServer')` in apply returned nothing → the whole package's routes 404. Since v0.6.1 route registration is hooked on `ctx.inject(['webServer'], …)` (re-registers everything once ready — 33 exact + 1 prefix + 1 upgrade); `remote()` is lazy — when `options.remoteBase` is empty, the first call reads `ctx.get('webServer').port`; if unavailable it returns an uncached client (keeping a retryable `REMOTE_UNAVAILABLE`). The smoke suite has a cold-start regression (0 routes → 33 + 1 upgrade + remote-base assertion).

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
| **v3.0-P0** | **安全基线**：本地账号 + 会话 + API token（`lib/auth.js`）、`can()` 默认拒绝判定（`lib/policy.js`）、部署锁落库（`lib/locks.js`）、哈希链审计（`lib/audit.js`）、runner 注册表与吊销（`lib/runners.js`）、审批绑产物摘要 + TTL + 禁自批；UI 加 hash 路由、左侧导航、面包屑、深链。**DSL 未改。** |
| **v3.0-P1** | **执行内核**：DSL v2（`stages[].jobs[]` + `needs` + `matrix`）归一成 job 图（`lib/model.js`），由 `lib/jobs.js` 按拓扑并发执行（默认并发 4，`jobs.concurrency` 可配）、表达式求值器不碰 `eval`（`lib/expr.js`）、T0/T1/T2 三档求值、每个 job 一份分片日志、每次运行落 `pipe.yml` 原文快照 + sha256。**v1 的 pipe.yml 一行都不用改。** |
| **v3.0-P2** | **工具链与动作**：`toolchain:` 只声明 vendor+版本（**永不接受 URL**），安装器解析 → 下载 → 按算法校验 → 解包进自己的 store，然后只往子进程注入**白名单 env**（宿主的 `JAVA_HOME` / `NODE_OPTIONS` 不许漏进来，宿主本身也一个字节不改）。锁文件 + `frozen` + 离线模式；Maven 的 `toolchains.xml` 与 Gradle 的 `installations.paths` 保证 daemon 用同一棵 JDK。`uses:` 执行七个内置动作（checkout / toolchain / cache / collect / deploy / verify / notify），**不引用任何外部 action**，未知动作或未知 `with` 参数是硬失败而不是静默跳过。 |

### 自检

```bash
node packages/dsh-cicd/test/smoke.mjs   # 102 项（含 08-security-rbac.md §10 的八条验收）
node test/mount.mjs                     # 全包挂载闸门（本包 26 工具 / 33 条 exact 路由）
```

## 组成

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 入口：26 个工具 + 33 条 exact 路由 + 1 条 prefix 路由（webhook）+ 1 条 WebSocket upgrade（实时日志），装配 runtime |
| `lib/pipe.js` | YAML 子集解析器（v1 与 v2）、`${{VAR}}` 插值、受限 `when` 表达式、glob、plan 与 DAG 执行器共用的 `buildStep()` 归一化、`triggers` 归一化 |
| `lib/runner.js` | 执行器两条路径共用同一套 step 实现：v1 按 stage 顺序走，v2（`stages[].jobs[]`）把 job 图交给 `lib/jobs.js`。写合并日志 + 每个 job 一份分片；secret 脱敏在每个出口之前；支持外部 `runId`、`AbortSignal` 取消、live 日志 hub |
| `lib/db.js` | SQLite 打开/DDL/迁移：runs、steps、artifacts、releases、operations、projects、deploy_locks、audit_events、users、memberships、api_tokens、sessions、approvals、runners + 索引，`PRAGMA user_version` 记录 schema 版本（当前 **v8**：v7 把 `steps.job_id` 加进主键，v8 给 runs 加 `config_snapshot` / `config_hash`；两者都在原库上就地迁移） |
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
| `lib/rbac.js` | 旧文件态 RBAC（远端服务模式，v2.0-M5）：三角色 + 项目范围 + 短 TTL token，载荷落 `workDir/.rbac.json`（0600）。**v3.0-P0 起被 `lib/auth.js` + `lib/policy.js` 取代**：它不再参与任何判定，`/rbac` 只用于查看/吊销遗留 token |
| `lib/auth.js` | v3.0-P0 身份：本地账号（scrypt，纯 JS 无原生编译）、DB 会话（HttpOnly cookie）与 API token（`cicd_<id>_<secret>`，只存 sha256，带 TTL 与吊销）、项目级成员关系。**引导期**：`users` 表为空时任何请求都是 `owner`，避免装完即锁死 |
| `lib/policy.js` | v3.0-P0 授权：`can(actor, action, resource) → {allow, reason, policyId}`，17 个动作 × 4 角色（viewer/operator/admin/owner），**默认拒绝**，永不抛异常 |
| `lib/audit.js` | v3.0-P0 审计：只追加的 `audit_events` + sha256 哈希链（`prev_hash` + 规范化记录）；`verify()` 逐条重算，定位第一处断裂（`kind: prev_hash | hash`） |
| `lib/locks.js` | v3.0-P0 部署锁：`deploy_locks` 表（重启后仍互斥）、TTL + 心跳；`release` 必须匹配 runId 或 owner（拒绝无条件释放），`forceRelease` 走审计 |
| `lib/runners.js` | v3.0-P0 runner 注册表：落库、online 为推导值（3 × 心跳）、吊销持久且立即生效（吊销过的 runner 重新注册不会复活） |
| `lib/expr.js` | v3.0-P1 表达式求值器：手写词法 + 递归下降，**不用 `eval` / `new Function`**（pipe.yml 是谁提 PR 谁能改的文件，真 JS 求值器等于给每个能提交代码的人在构建机上开一个任意执行入口）。T0/T1/T2 根白名单 + 固定函数表 |
| `lib/model.js` | v3.0-P1 模型归一化：v1 每个 stage → `<stage>-main` job（每个 `deploy` step 拆成独立 `kind:'deploy'` job），v2 `stages[].jobs[]` 原样展开，`matrix` 展开成 `job[key=value,...]`（上限 64 实例 / 3 维），`resolveJobGraph()` 接受 job id / matrix 基名 / stage id 三种 `needs` 写法并回写成真实 id |
| `lib/jobs.js` | v3.0-P1 DAG 调度器：`scheduleJobs({jobs, concurrency, signal, runJob, onSkip})` 把就绪 job 放进并发池，失败**与跳过**都向下传播（上游被跳过的下游不是绿的），`allow_failure` 可豁免 |
| `lib/toolchain.js` | v3.0-P2 工具链：`parseSpec` / `pickVersion` / provider（Adoptium、Maven、Gradle、Node、Go；PHP 无官方可移植包）、`mkdir` 跨进程锁 + 进程内 inflight 复用、按算法校验（Maven 只发 sha512、Node 只发 sha256）、`envFor()` 白名单注入、`assertVersions()` 版本断言。**pipe.yml 只允许写 `vendor+版本`** —— 在那里写 URL 会让任何能提 PR 的人在构建机上执行任意二进制 |
| `lib/actions.js` | v3.0-P2 `uses:` 动作：七个内置，各自声明所需能力；未知动作 / 未知 `with` 键 / 缺能力全部硬失败。刻意不支持引用外部 action |
| `lib/cache.js` | v3.0-P2 构建缓存：`<workDir>/cache/entries/<sha256(project,key)>/{meta.json,files/}`，先精确 key 再 `restore_keys` 前缀匹配，staging + rename 原子提交。`paths` 必须是项目相对路径或以 `~/` 开头 —— 绝对路径直接拒绝（否则 `paths: ["/etc"]` 能把宿主整个打包） |
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

`cicd_projects` / `cicd_project_meta` / `cicd_project_create` / `cicd_validate` / `cicd_pipe_save` / `cicd_plan` / `cicd_run`（`dryRun`、`stage`、`confirm`、`runner`、`approvalId`）/ `cicd_status` / `cicd_logs` / `cicd_releases`（可按 `host` 过滤）/ `cicd_rollback`（可选 `host`）/ `cicd_targets`（含 runtime/app/onHostFailure/keep/restartCommand 与每台 active）/ `cicd_cancel`（`runId`）/ `cicd_dora`（`project`、`days`）/ `cicd_triggers`（`project`，返回 triggers 摘要、webhook URL 与调度器快照）/ `cicd_runners`（列表 + `action=revoke`；labels、容量、在线/吊销状态、在跑任务数）/ `cicd_approve`（`approvalId` 或 `runId`、`decision`、`reason`、`resolvedBy`）/ `cicd_secrets`（`project`、`scope`、`name`、`value`）/ `cicd_environments`（`project`）/ `cicd_rbac`（`user`、`role`、`projects`、`ttlSec`、`token`、`action`，遗留）/ **`cicd_auth`**（`action=me|login|logout`）/ **`cicd_users`**（`action=list|create|get|set-password|set-role|remove-role`）/ **`cicd_tokens`**（`action=list|create|revoke`）/ **`cicd_audit`**（`action=list|verify`）/ **`cicd_locks`**（`action=list|release`）。

## HTTP 路由（GET + resource，另加 1 条 prefix 与 1 条 upgrade）

`/api/plugins/cicd/{projects,project-meta,project-create,validate,pipe-save,plan,run,runs,log,releases,rollback,targets,operations,notify-test,cancel,dora,triggers,runner-register,runner-poll,runner-result,runner-log,runners,approve,approvals,secrets,environments,rbac,auth,users,tokens,audit,locks,toolchain}` 共 33 条精确路由；`run` 支持可选 `runner` 参数指定构建主机、可选 `approvalId` 消费一条已批准的审批；`runner-*` 五条是远端 runner 拉取式协议的入口（register 带 join token、poll 兼心跳、result 回报幂等、log 逐行推送），**不校验同源**（跨机调用），靠 join token 鉴权；`runners` 要求同源。另外两条特殊入口：prefix 路由 `/hooks/<project>`（入站 webhook，靠 token 鉴权、不校验同源）与 upgrade `/log-ws?runId=`（实时日志）。

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
- **构建缓存**：`uses: cache` 在构建前恢复、在 job 结束的收尾钩子里保存（跑到那一步时 `dist/` 还是空的——GitHub 的 post steps 是同一个理由）。先精确 key，再 `restore_keys` 前缀。`paths` 必须是项目相对路径或以 `~/` 开头，绝对路径直接拒绝。`artifacts` 表仍记录每次 run 的产物，`keep` 清理复用 deploy.js 的 `cleanupReleases`；内容寻址的制品库（不可变摘要、去重、跨环境晋升）是 P5，不是这一轮。

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

## 身份、判定、锁与审计（v3.0-P0）

v2 的四条漏洞：写路由只有「同源 + 请求头 + `confirm=1`」、部署锁是进程内 `Map`、审计只留 500 条且无法验真、审批门重启即忘。v3.0-P0 在不改 DSL 的前提下把这四条堵住。

**身份（`lib/auth.js`）**，按 API token → 会话 cookie → 引导期 的顺序判定：

- **账号本地化**：`/users?action=create`（或 `cicd_users`）传 `email` + `password`，口令用 scrypt（`N=2^15, r=8, p=1`，纯 JS，不需要原生编译，也不引入 argon2 依赖）；少于 8 位直接拒。
- **会话**：`/auth?action=login` 回 HttpOnly `dsh_cicd_session` cookie（`SameSite=Strict`），默认 12 小时；`logout` 清除。库里只存 sha256 摘要。
- **API token**：`/tokens?action=create&userId=…&ttlSec=…` 一次性返回 `cicd_<id>_<secret>`，之后只存摘要；用 `Authorization: Bearer …` 或 `x-dsh-cicd-token: …` 传。过期 → `TOKEN_EXPIRED`，吊销 → `TOKEN_REVOKED`。
- **引导期**：`users` 表为空时任何请求都是 `owner`（`authMethod=bootstrap`），避免装完没人能操作。第一个账号必须给 `role=owner`——`admin` 无权管成员，事后无法自我提升。一旦存在用户，匿名访问立即 401（`AUTH_REQUIRED`）。

**授权（`lib/policy.js`）**：所有写路由收敛到 `can(actor, action, resource) → {allow, reason, policyId}`，**默认拒绝**：未知动作、无主体、主体停用、token 越界、无成员关系、角色不足，全部 deny。17 个动作 × 4 角色：

| 角色 | 能做 |
|---|---|
| `viewer` | 读 |
| `operator` | + 触发/取消/重试/部署非 prod/回滚非 prod/审批 |
| `admin` | + 改配置/管 secret/揭示 secret/部署 prod/回滚 prod/管 runner/管项目/读审计 |
| `owner` | + 管成员/管环境 |

`prod`（或 `protected: true`）额外要求 `admin` 才能部署/回滚/改环境，即使项目已授权；角色按项目授予，不隐式继承。

**部署锁（`lib/locks.js`）**：锁落在 `deploy_locks` 表，「一个 target 同时只跑一次」重启后依然成立。每条锁带 TTL（默认 1800s）并按 1/3 周期心跳续期，进程崩了也能自动释放，不用手工清。`release()` 必须匹配 runId 或 owner——无条件释放会让 A 误删 B 的锁。`forceRelease` 仅 admin 且写审计。

**审计（`lib/audit.js`）**：`audit_events` 只追加，每行带 `prev_hash` 与 `hash = sha256(prev_hash + 规范化记录)`。`cicd_audit verify`（`/audit?action=verify`）逐条重算，报出第一处断裂（`kind: prev_hash` 是链断，`kind: hash` 是原地改字段）。允许与拒绝都记——被拒的写操作恰恰是排查事故时最想要的信号。

**审批**：请求落库而不是留在内存，`approvals` 存 target、申请人、过期时间（默认 4h）与**产物摘要**。三条规则让它真的安全：审批人不能是申请人（`SELF_APPROVAL_FORBIDDEN`）、一条审批只能消费一次（第二次 `APPROVAL_CONSUMED`）、摘要必须一致（`APPROVAL_DIGEST_MISMATCH`）。摘要在审批时产物还不存在，因此取「决定字节内容的全部输入」（`project + target + commit + pipeline + stage`）：同一提交重算摘要不变，换提交就变。过期由懒扫描回收：运行落 `failed(approval_timeout)`，审计落 `approval.timeout`。

**Runner**：注册是 DB 行，`online` 由 `last_seen_at` 推导（3 × 心跳判死），**吊销持久且立即生效**——被吊销的 runner 领不到任务，迟到的结果一律丢弃。

**UI（P0-6/P0-7）**：面板引入 hash 路由，视图可寻址、刷新不丢：

```
#/projects/:project[/runs/:runId | /releases | /approvals | /pipeline | /new | /runners | /secrets | /rbac | /audit][?target=&step=&line=]
```

用 hash 而不是 `history.pushState`：面板挂在宿主页面里，改写宿主路径会让宿主刷新 404；片段只动 `#` 之后，宿主路由不受影响，面板自己还原视图。13 个同权重工具条按钮改成左侧导航（流水线 / 配置 / 管理），工具条只留项目、目标、构建主机、计划、干跑、运行、刷新；面包屑显示 `项目 › 视图 › 运行` 并带「复制链接」；`?line=1204` 会高亮并滚动到该行日志。

## DSL v2 执行内核（v3.0-P1）

v1 是「一个 stage = 一串按顺序执行的 step」：stage 内部无法并行、没有 `needs`、即便没有任何依赖也必须排队。v3.0-P1 引入 `stages[].jobs[]` 并按 DAG 执行。**v1 的 pipe.yml 一行都不用改**——归一化器把每个 v1 stage 变成一个 `<stage>-main` job，于是老行为是新引擎的一个特例，而不是需要手工维护的第二条代码路径。

```yaml
version: 2
stages:
  - id: test
    jobs:
      - id: unit
        matrix: { java: ["17", "21"] }
        steps:
          - run: mvn -B verify
      - id: lint
        steps:
          - run: mvn -B spotless:check
  - id: ship
    jobs:
      - id: gate
        needs: [unit, lint]        # matrix 基名会展开成两个实例
        steps:
          - run: echo release
      - id: deploy
        needs: [gate]
        steps:
          - deploy: { target: prod }
```

- **job 图（`lib/model.js`）**：`stage` 只保留两件事——在 UI 里分组、以及「没写 `needs` 的 job 默认等上一个 stage 的所有 job」。一旦有 job 显式写了 `needs`，顺序完全由 DAG 决定。`needs` 接受三种写法：真实 job id、matrix 基名（`unit` → 全部实例）、stage id 或 `stage:<id>`；`resolveJobGraph()` 全部回写成真实 id，下游代码再也不会看到基名。成环报 `PIPE_CYCLE` 并带路径（`job 依赖出现环：a → b → a`），找不到报 `PIPE_UNKNOWN_JOB` 并带候选列表。
- **matrix**：`matrix: {java: [17, 21]}` 展开成 `unit[java=17]` / `unit[java=21]`（键排序，实例 id 稳定）。硬上限 64 实例、3 维，`exclude` 做精确剔除——5×4×4 会在解析期就报 `PIPE_MATRIX_TOO_LARGE` 并在消息里给出实际数量，而不是 80 个 agent 亮起来之后才发现。
- **调度器（`lib/jobs.js`）**：就绪 job 进并发池（`jobs.concurrency`，默认 4，clamp 1–32）。失败**和跳过**都向下传播：上游被跳过的下游也是 skipped，不是绿的——这是 GitHub 的语义，也是 `blocksDownstream` 把 `skipped` 算作阻塞的原因。`allow_failure: true` 让该 job 不传播。
- **表达式（`lib/expr.js`）**：`when:`、`if:`、`${{ … }}` 由手写词法 + 递归下降解析求值，**刻意不用 `eval` / `new Function`**：pipe.yml 是谁提 PR 谁能改的文件，真 JS 求值器等于给每个能提交代码的人在构建机上开一个任意执行入口。`evaluate('process.exit(0)')` 现在返回 `PIPE_EXPR`。
- **三档求值**：T0（`event` / `branch` / `tag` / `paths` / `ref`）→ T1（加 `vars` / `matrix` / `needs` / `env` / `project` / `target` / `stage`，job 图在这一档决定）→ T2（加 `secrets` / `steps` / `outputs`，唯一在真正 spawn 命令时求值的档）。在 `when:` 里引用 `secrets` 是 T1 错误，且错误消息直说原因：*T1 的求值结果会进 run 记录与日志，那正是密钥不能落的地方*。`validateExpressions()` 在解析期跑同一套白名单，非法表达式一条命令都不跑就失败。
- **配置快照**：每次运行把 pipe.yml 原文（`runs.config_snapshot`）与 sha256（`config_hash`）落库。重跑与重试读快照，不重读工作区——否则有人一改文件，「昨晚那次到底跑的是什么」就永远说不清。
- **日志分片**：合并时间线保留（判断先后顺序时你要的就是它），另外每个 job 单独一份 `logs/<runId>/<job>.log`。`cicd_logs` / `/log?jobId=` 读分片；matrix 实例名里的 `[ ] = ,` 在文件名里换成 `_`（这几个字符在 Windows 上是非法的）。面板日志区加「只看某个 job」下拉，且只在 job 多于一个时出现（只有一个选项的下拉纯属噪音）；stage 与 step 之间渲染 job 行——否则「哪几步是并行的」根本看不出来。

**客户端**：`timelineRows(stages, jobs)` 插入 job 行；`jobId` 匹配不到任何 job 的 step 落进显式的「（未分组）」块，而不是消失。`runJobsOf()` 优先用 `/run` 返回的 job 图（有状态、耗时、依赖），退回 `/log` 的分片清单（只有 id，状态留空——未知就渲染成未知，绝不当成成功）。切换运行会清空已选的 job 分片，因为 A 的 `jobId` 在 B 里不存在，Host 只能回 404。

## 工具链与动作（v3.0-P2）

```yaml
version: 2
toolchain:
  java: temurin-17      # 厂商 + 版本号，永远不写 URL
  maven: "3.9.6"
stages:
  - id: build
    jobs:
      - id: compile
        steps:
          - uses: checkout
            with: { fetch_depth: 1 }
          - uses: cache
            with:
              key: m2-${{ vars.JAVA }}
              paths: [ "~/.m2/repository" ]
          - run: mvn -B -DskipTests package
          - uses: collect
            with: { paths: [ "target/*.jar" ], name: app }
```

- **声明式，不是命令式。** `toolchain:` 只说「必须存在哪个版本」，从不说「去哪儿拿」。安装器自己解析（先锁文件，再 provider）、下载、校验、解到自己的 store（`<workDir>/toolchains/store/<lang>/<version>/<platform>`），最后才注入。宿主一个字节都不改：不写 shell rc、不建全局链接、不 export。
- **白名单 env（`envFor`）。** 子进程拿到的是一份按白名单重建的环境，`PATH` 前置，`JAVA_HOME` / `PYTHONHOME` / `GOROOT` 显式覆盖或删除。宿主自己的 `JAVA_HOME`、`NODE_OPTIONS` 不许偷偷改变构建结果——这才是真正要治的病。`GOTOOLCHAIN=local` 阻止 Go 自己再下一个工具链、绕过锁。
- **校验按算法。** Maven 只发 `.sha512`，Node 只发 `SHASUMS256.txt`，Adoptium 发 sha256。只认 sha256 就等于放弃 Maven 校验，所以 `parseChecksum()` 同时接受 `sha512:` / `sha256:` / `sha1:` 前缀与裸 hex（按长度判定）。
- **锁与离线。** `pipe.lock` 以 `lang@spec@platform` 为键，一条 entry 可以同时记多个平台，于是同一份 `pipe.yml` 在 Windows 宿主和 Linux runner 上都能构建。`frozen: true` 且锁里没有条目时立即失败、**不问任何索引**，这才是可重复的内网构建。`offline: true` 的含义是「不许上外网」而不是「不许读文件」：`file:///opt/mirror/...` 照样能用，内网镜像正是离线构建存在的理由。
- **版本断言。** 装完之后在注入的 env 里跑 `java -version` / `mvn -v` / `node --version` / `go version`，与声明版本比对。装了 17 却跑出 21 是最难在事后归因的一类问题，所以它在运行开始时失败，而不是在产物里失败。
- **不引用外部动作。** `uses:` 只认七个名字：`checkout`、`toolchain`、`cache`、`collect`、`deploy`、`verify`、`notify`。未知动作 `ACTION_NOT_FOUND`，未知 `with` 键 `ACTION_INPUT_INVALID`，缺能力 `ACTION_UNAVAILABLE`，一律硬失败：静默跳过会让流水线看起来绿了、实际什么都没做，那是最坏的失败方式。引用别的仓库里的 action 是刻意做不到的——那会把 CI 变成对外开放的远程执行入口，要安全地做需要 pin + 审计 + 签名一整套，本包没有。自定义逻辑请写 `run:`。
- **checkout 不切分支。** runner 直接在项目目录里构建，替你 `git checkout` 会改掉你自己的工作副本，下一次 `git status` 里会出现你根本没做过的改动。`uses: checkout` 只 fetch 和初始化子模块；声明了 `ref` 就**校验** HEAD 是不是它，不一致直接失败并说明原因。
- **缓存是「先恢复、收尾再存」。** 跑到这一步时 `dist/` 还是空的，所以保存登记成 job 结束时的收尾钩子（GitHub 的 post steps 同一个理由）。key 先精确匹配，再按 `restore_keys` 前缀匹配——一份过时的依赖缓存也比没有强。`paths` 必须是项目相对路径或以 `~/` 开头：绝对路径直接拒绝，否则 `paths: ["/etc"]` 会把宿主整个打包进一份缓存，然后被恢复进下一个项目。
- **能力注入。** 动作不知道自己跑在哪儿，它只声明「我要 git / 工具链 / 部署器」，由 `createActionRuntime()` 递上真实现。`deploy` 被包装成一个只有 `deploy` 字段的假 step 交给既有的 `deployStep`，于是生产确认、选择器展开、锁、审计、回滚都没有被重写一遍——也就不会漏掉其中某一条。


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
- RBAC token 落 `workDir/.rbac.json`（0600），DB 只存 sha256 摘要；token 短 TTL（默认 3600s），过期自动拒；写操作全审计（最近 500 条），`action=audit` 导出全部。**v3.0-P0 起这套文件态 RBAC 不再参与判定**，改由 `lib/auth.js`（身份）+ `lib/policy.js`（判定）接管，`/rbac` 仅用于查看/吊销遗留 token。
- v3.0-P0 身份：口令 scrypt（纯 JS，`maxmem` 按参数算，避免 Node 默认 32MiB 上限直接抛）；DB 只存口令哈希与 token/session 的 sha256 摘要；会话 cookie `HttpOnly; SameSite=Strict`。
- v3.0-P0 判定：所有写路由先同源、再要求 `x-dsh-cicd` 头与 `confirm`，再过身份，最后 `can()`；任一环节拒绝都写审计（`auth.deny:*` / `policy.deny`），**默认拒绝**，未知动作一律不放行。
- v3.0-P0 锁：`deploy_locks` 落库，TTL + 心跳，`release` 必须匹配 runId/owner；`forceRelease` 仅 admin 且审计。
- v3.0-P0 审计：哈希链，`/audit?action=verify` 可定位第一处断裂；允许与拒绝都记。
- v3.0-P0 审批：绑产物摘要（project+target+commit+pipeline+stage 派生）、有 TTL、禁自批、一次性消费；过期运行落 `failed(approval_timeout)`。
- v3.0-P0 runner：注册落库，`online` 由心跳推导（3× 判死），吊销持久且立即生效，迟到结果丢弃。
- v3.0-P0 日志脱敏：secret 明文在写文件 / `onLog` / live hub 三个出口**之前**统一替换成 `***`，值长度 < 4 的不替换（短值替换只会毁掉可读性）。
- v3.0-P1 表达式：`when` / `if` / `${{ }}` 走手写解析器，**不碰 `eval` / `new Function`**；根标识符按 T0/T1/T2 白名单放行，函数只有固定 11 个（`startsWith` / `endsWith` / `contains` / `matches` / `changed` / `exists` / `always` / `success` / `failure` / `cancelled` / `skipped`），`process` / `require` / `globalThis` / 立即调用表达式全部 `PIPE_EXPR`。
- v3.0-P1 `secrets` 只在 T2 可见：T1（建图阶段）读到 `secrets` 直接报错，因为 T1 的结果会进 run 记录与日志。
- v3.0-P1 matrix 上限 64 实例 / 3 维，超限在解析期拒绝；否则一次误写就能把构建机打满。
- v3.0-P2 工具链：`toolchain:` 只接受 `vendor+版本`，**含 `:` `/` `\\` 一律拒绝**——pipe.yml 是 PR 可改的文件，在这里放开 URL 等于允许任何有提交权限的人让构建机下载并执行任意二进制。内网镜像走框架级配置（`file:///opt/mirror/...`），不经过仓库文件。
- v3.0-P2 注入：子进程 env 只取白名单，不 spread `process.env`；`PATH` 前置并按需覆盖 `JAVA_HOME` / `PYTHONHOME` / `GOROOT`，`GOTOOLCHAIN=local`。宿主装了什么完全不影响构建结果，宿主本身也一个字节不改。
- v3.0-P2 校验：按算法重算（`sha512` / `sha256` / `sha1`），校验不过**先删坏包再抛**，不写 store；解包走 `.tmp-<pid>-<rand>` → `.ok` 标记 → `rename` 原子提交，半成品永远不会被当成可用工具链。
- v3.0-P2 动作：`uses:` 只认七个内置名字，未知动作 / 未知 `with` 键 / 缺能力**全部硬失败**。不引用外部 action——那会把 CI 变成对外开放的远程执行入口。
- v3.0-P2 缓存：`paths` 只允许相对项目目录或以 `~/` 开头，**绝对路径直接拒绝**（否则 `paths: ["/etc"]` 能把宿主整个打包）；恢复时再校验解析结果仍在根内，防 `..` 逃逸；不存符号链接。
- v3.0-P2 checkout 不切分支：runner 直接在项目目录构建，替你 `git checkout` 会改掉你自己的工作副本。声明了 `ref` 就只校验 HEAD 是否一致，不一致直接失败并说明原因。
- 日志读取有 `maxLogBytes` 截断；`runId` 做了字符白名单校验。

## 自检

```bash
node packages/dsh-cicd/test/smoke.mjs   # 102 项：解析/计划/存储/执行/发布/灰度/通知/审计/路由/选择器/护栏/锁/迁移/向导/编辑器/脚手架/cron/triggers/scheduler/webhook/log-ws/cancel/DORA/executor/broker/joinToken/strategy(5 策略+策略锁)/environments/approvalGate/secrets/RBAC + v3.0-P0 的 auth/policy/locks/audit/runners + docs/proposals/cicd-v3/08-security-rbac.md §10 的八条验收 + v3.0-P1 的 expr/model/jobs（v1 归一化回归、matrix 上限、成环、并发池、跳过传播、取消、v2 端到端、配置快照、日志分片） + v3.0-P2 的工具链（宿主只有 JDK21 却声明 17、并发 job 各自不同 JDK、离线+frozen、被篡改的包、双平台锁、缓存命中、失败记录、Maven/Gradle 双锁）与动作（未知动作/未知参数硬失败、verify 重试、checkout 拒绝切分支、缓存往返+前缀命中+绝对路径拒绝、v1 的 uses: 端到端）
node test/mount.mjs                     # 全包挂载闸门（本包 26 工具 / 33 条 exact 路由）
```

不连真实 SSH：remote 用假 fetch，deploy 用记录命令的假 remote。

## 冷启动路由注册与惰性 remote（v0.6.1）

与 dsh-remote 同病：冷启动时 `webServer` 晚于插件 `apply()`，v0.6.0 起在 apply 里同步 `ctx.get('webServer')` 拿不到服务 → 整包路由 404。v0.6.1 起路由注册挂到 `ctx.inject(['webServer'], …)`（就绪后补注册全部路由，v3.0-P0 起是 33 条精确路由 + 1 条 prefix + 1 条 upgrade）；`remote()` 改惰性解析——`options.remoteBase` 为空时首次调用从 `ctx.get('webServer').port` 取，取不到返回未缓存客户端（保持可重试的 `REMOTE_UNAVAILABLE`）。smoke 有冷启动回归（0 路由 → 33 条精确路由 + 1 条 prefix + 1 条 upgrade + remote base 断言）。

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
