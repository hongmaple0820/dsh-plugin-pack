# 制品库与多形态部署（设计稿）

## 一、制品模型

**结论：制品是一等公民，但必须把 artifact（字节）与 release（部署意图）分成两层。** 只存 tag 的系统无法保证「回滚到同一份字节」。

```sql
artifacts(id PK, digest UNIQUE, size, media_type, kind, blob_path, created_at,
          run_id, commit_sha, provenance_json, retention_class, deleted_at)
tags(repo, tag, digest, mutable, updated_at, PK(repo,tag))
promotions(id, digest, env, approved_by, approved_at)
releases(id, target, artifact_digest, mode, config_hash, state,
         created_at, activated_at, superseded_by)
release_instances(release_id, host, slot, port, pid, container_id, weight, health, log_path)
```

- `digest` 是唯一身份（id 可由它派生）；`size`/`mediaType` 用于校验与 OCI 路由；`kind ∈ generic-tar | maven | npm | pypi | oci-image | oci-artifact`。
- `provenance` 必填：run_id、commit、builder 镜像 digest、构建参数 hash、SBOM digest、签名。
- promotion 不复制字节：写 `promotions` + 环境指针，校验 digest 恒等，记录审批人与时间。
- retention：GC 只删「已软删 + refcount=0 + 无任何 release 引用」的 blob。Nexus 用 cleanup policy + compact blob store（软删 3 天），[Sonatype](https://help.sonatype.com/en/cleanup-policies.html)；Harbor 用 tag retention，[Harbor](https://goharbor.io/docs/2.15.0/working-with-projects/working-with-images/create-tag-retention-rules/)。
- **tag 是可变指针**：Harbor 需显式开 tag immutability 才能阻止漂移（Distribution 上游不强制 tag↔digest 映射），[Harbor](https://goharbor.io/docs/2.15.0/working-with-projects/working-with-images/create-tag-immutability-rules/)。内部一律只认 digest。

各格式落盘路径（做兼容层时照抄）：

- Maven：`<groupId 转路径>/<artifactId>/<version>/<artifactId>-<version>[-classifier].<ext>` + 每级 `maven-metadata.xml`，[布局](https://maven.apache.org/repository/layout.html)、[元数据模型](https://maven.apache.org/ref/3.9.16/maven-repository-metadata/index.html)。Nexus 格式矩阵见 [Formats](https://help.sonatype.com/en/formats.html)；Artifactory 用 `repoLayoutRef=maven-2-default` 这类路径模板，[JFrog](https://docs.jfrog.com/artifactory/docs/repository-layouts)。
- npm：`GET /:pkg` 返回 packument（versions、dist-tags），每版本带 `dist.tarball` 与 `dist.integrity`（SRI `sha512-…`），[registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)、[integrity](https://docs.npmjs.com/about-registry-signatures)。
- PyPI：`GET /simple/<project>/`，按 Accept 在 PEP 503 HTML 与 PEP 691 JSON 间协商，[PyPI](https://docs.pypi.org/api/index-api/)、[PEP 503](https://peps.python.org/pep-0503/)、[PEP 691](https://peps.python.org/pep-0691/)。
- OCI：`/v2/`、`/v2/<name>/manifests/<tag|digest>`、`/blobs/<digest>`、`/tags/list`、`/referrers/<digest>`，[OCI Distribution](https://github.com/opencontainers/distribution-spec/blob/main/spec.md)、[Registry V2](https://distribution.github.io/distribution/spec/api/)。任意文件用 ORAS 打成 OCI artifact，签名/SBOM 走 referrers，[ORAS](https://oras.land/docs/)。
- 托管服务只作对照：GitLab Maven 同名同版本会合并文件（不能当不可变源），[GitLab](https://docs.gitlab.com/user/packages/maven_repository/)；GitHub Packages 与仓库权限绑定，[GitHub](https://docs.github.com/en/packages/learn-github-packages)。

## 二、三种部署形态

统一语义只有一句：`deploy(artifact_digest, target) → release`，四阶段 **stage → activate → verify → commit/abort**，形态差异压进 Actuator 的 5 个方法：`stage / activate / health / stop / cleanup`。

| | native | container | k8s |
|---|---|---|---|
| stage | 解包 `releases/<id>/` | `docker pull repo@sha256:…` | 改 image 为 digest |
| activate | symlink 原子换 + restart | 起新容器 + proxy 切流 | patch Deployment/Rollout |
| rollback | 指回 previous + restart | 换回旧 digest | `rollout undo` |
| 批次归属 | 我们按 host | 我们按 host | 控制器 maxSurge/maxUnavailable |

- **能共用 release/rollback 语义**（同一张 releases 表、同一 manifest、同一判据、同一 UI），**不能共用激活实现**。边界就是 Actuator；把 k8s 塞进 symlink 语义只会做出假的滚动发布。
- native 标准模型即 Capistrano（`releases/`、`current` 软链、`shared/`），[Capistrano](https://capistranorb.com/documentation/getting-started/structure/)；Deployer(PHP) 同构，[Deployer](https://deployer.org/docs/7.x/basics)。
- systemd：普通场景 `systemctl restart`；零停机用 socket activation，新进程继承监听 fd（`$LISTEN_FDS`），配合 `sd_notify` 报就绪，[systemd.socket](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html)。PM2 用 `pm2 reload` 逐个替换 worker，[PM2](https://pm2.keymetrics.io/docs/usage/cluster-mode/)。
- 容器：buildx 多阶段构建，[multi-stage](https://docs.docker.com/build/building/multi-stage/)；compose 用 `profiles` 分环境、`healthcheck` 定就绪、`depends_on` 只保证启动顺序（要等健康需 `condition: service_healthy`），[profiles](https://docs.docker.com/compose/how-tos/profiles/)、[services](https://docs.docker.com/reference/compose-file/services/)。
- k8s：RollingUpdate 默认 25%，[Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)；readiness/liveness/startup 语义不同，[probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)；灰度交 Argo Rollouts（canary 的 setWeight/pause/analysis、blueGreen 的 active/preview Service），[canary](https://argo-rollouts.readthedocs.io/en/stable/features/canary/)、[analysis](https://argo-rollouts.readthedocs.io/en/stable/features/analysis/)；GitOps 与 sync-wave 见 [Argo CD](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)。
- 参考实现：Ansible 用 `serial` 分批、`strategy: free` 放开主机并行、`max_fail_percentage` 中止，[strategies](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_strategies.html)；Kamal 由 kamal-proxy 持流量——起新容器→探活→切流→旧容器 drain，应用无需配合，[proxy](https://kamal-deploy.org/docs/configuration/proxy/)；Dokku 部署后等一个可配的 checks 窗口再切流，旧容器继续服务，[zero-downtime](https://dokku.com/docs/deployment/zero-downtime-deploys/)；Coolify 按 Dockerfile/compose/静态等方式构建并托管容器生命周期，[docs](https://coolify.io/docs/applications/choose-deployment-method)。

## 三、多主机多实例

三级：**Target（环境）→ Host（故障域）→ Instance（调度/观测最小单位）**。instance 不是副本数，它绑定端口、权重、健康、日志。

```yaml
targets:
  prod:
    mode: native                 # native | container | k8s
    hosts:
      - { name: prod-1, address: 10.0.0.11, max_instances: 4 }
      - { name: prod-2, address: 10.0.0.12, max_instances: 4 }
    instances:
      count: 6                   # 均摊 prod-1:3 / prod-2:3
      port: { base: 8080, step: 1 }   # 8080..8085，落盘 slot 锁
      weight: 100                # 期望值，由流量层 reconcile
      health:
        http: "http://127.0.0.1:{{.port}}/healthz"
        expect: 200
        interval: 2s
        timeout: 1s
        retries: 5
        start_period: 10s
      drain: { delay: 5s, timeout: 30s }
      log: "/srv/{{.app}}/logs/{{.release}}/{{.host}}-{{.slot}}.log"
      env: { PORT: "{{.port}}", INSTANCE_ID: "{{.host}}/{{.slot}}" }
```

- 端口：`O_EXCL` 写 `slots/<host>/<port>.lock`（pid+release），启动时按 pid 存活与端口探测回收僵尸锁；容器用 `-p 0` 让 docker 分配，再 `docker port` 读回。
- 权重只存在于流量层（kamal-proxy / nginx upstream / Service），DB 存期望值，部署后 reconcile 实际值并告警偏差。
- 日志：native 走 `app@<slot>.service` + journald 或 per-instance 文件；容器 `docker logs --since`；统一 `log_path` 供面板聚合。
- 顺序：全部主机先 `stage`（不接流量）→ 统一 `activate` → 逐台 verify → commit；任一台失败只回滚已激活的机器（补偿事务），未激活的直接清理。

## 四、判定规则

三级探针：L1 进程/端口 → L2 readiness（HTTP 200 + body 匹配 + 依赖 ping）→ L3 观察窗（错误率/延迟）。

| 判据 | 默认阈值 | 动作 |
|---|---|---|
| L2 通过 | 5 次 ×2s 内成功 | 继续 |
| L2 失败 | 连续 2 次或 12s 超时 | abort + 回滚 |
| L3 回滚 | 60s 内 5xx>5% 或 p95>2×基线 或 健康实例<N-1 | 自动回滚 |
| 超时 | 单机 300s、整批 900s | 按失败处理 |
| 金丝雀 | 5→25→50→100%，每步≥5min 且≥1000 请求 | analysis 失败回退 0% |
| 滚动 | 批 = maxUnavailable（k8s 默认 25%） | 批间 verify |

- 蓝绿：新组全绿再切 100%，旧组留 T 分钟（回切=指回），代价双倍资源。
- 优雅停机：**先摘流量 → 等 drain.delay（≥2×健康检查间隔）→ SIGTERM → 等 timeout → SIGKILL**；k8s 端点摘除与 SIGTERM 并行，必须 preStop sleep，[pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-termination/)。
- **回滚前必须已持久化**（缺一不可）：上一 release id + **digest**（不是 tag）；每主机 current/previous 指针；每 instance 的 host/slot/port/pid/container_id；激活前的 unit/compose/env 快照；健康检查配置快照；迁移标记与版本号；权重与 proxy 配置版本；部署锁与操作者。manifest 同时写 `releases/<id>/.dsh-manifest.json` 与 DB，离线可读。
- 非线性步骤用 stage 类型表达，不塞进 shell：`migrate`（expand/contract，标 irreversible，默认 manual）、`assets`（版本化路径，失败不阻塞旧版）、`warmup`（失败只告警）、`smoke`（失败触发回滚）。顺序：migrate(expand) → deploy → warmup → smoke → migrate(contract, 下一版)。**迁移不可回滚，只能 roll forward。**

## 五、内建最小制品库

结论：不做 Nexus，做「本地 CAS + 只读 HTTP + 单一写入口 + OCI 兼容层」（约 1500 行）。

```
data/cas/sha256/ab/cdef…   # 唯一写入点：.tmp → rename
data/index.sqlite          # artifacts/tags/promotions/releases/referrers
data/trash/                # 软删，7 天后硬删
```

| 端点 | 语义 |
|---|---|
| `PUT /api/v1/blobs` | 流式收，边收边算 sha256；不符 400，已存在 200 幂等 |
| `GET /cas/sha256/<digest>` | Range/ETag，`Cache-Control: immutable` |
| `GET /repository/maven/<path>` | `maven-metadata.xml` 由 DB 生成 |
| `GET /repository/npm/<pkg>` | packument，`dist.tarball` 指向 CAS |
| `GET /simple/<project>/` | Accept 协商 PEP 503/691 |
| `GET /v2/…` | manifests / blobs / tags/list / referrers |

认证沿用 Docker token 流程（`/v2/` 401 + `WWW-Authenticate: Bearer`），[token auth](https://distribution.github.io/distribution/spec/auth/token/)。成本与风险：单盘无 HA；GC 依赖引用计数，算错会删在用 blob（先 tombstone）；无 pull-through 缓存；provenance 只记录不验签；OCI 只实现 pull/push 子集。接 Nexus/Artifactory/Harbor 时当 upstream proxy，内部仍只认 digest。

## 六、失败模式

| 症状 | 根因 | 对策 |
|---|---|---|
| 回滚后行为变了 | 按 tag 回滚，tag 已漂移 | 只按 digest 回滚 |
| 切换后仍 502 | symlink 换了但进程未重启/持旧 fd | activate 必含 restart 或 socket activation |
| 探针过但接口 500 | 探针不含依赖 | readiness 加依赖 ping + smoke |
| 半数主机成功 | 无全局事务 | per-host 状态表 + 补偿回滚 + 幂等重试 |
| 新实例起不来 | 僵尸进程占端口 | slot 锁 + pid/端口探测回收 |
| 产物损坏 | 磁盘满/半包 | 流式 sha256 + `.tmp` rename + 空间预检 |
| 回滚后数据错乱 | 迁移已执行 | irreversible 标记 + expand/contract + 人工 |
| 发布瞬间雪崩 | 缓存冷、资源未预热 | warmup + 版本化资源路径 |
| 长连接被切断 | drain 短于连接寿命 | drain.delay ≥ 最大请求时长 + preStop |
| 回滚无版本 | revisionHistoryLimit=0 或 release 被 GC | 保留 N 个 + pinned 永不删 |
| 并发部署互踩 | 无锁 | 每 target 一把带 TTL 的 deploy lock |
| 拉镜像 401 | registry token 过期 | 部署前 refresh，失败即中止 |
