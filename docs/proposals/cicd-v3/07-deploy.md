# 07 · 部署模型：多主机、多实例、原生 / 容器 / K8s

> 回答的问题：**「不支持部署到多个主机或多个实例？原生部署和 Docker 部署都支持吗？回滚凭什么可靠？」**
> 结论：统一语义只有一句 —— `deploy(artifact_digest, target) → release`，
> 四阶段 **stage → activate → verify → commit/abort**，形态差异压进 Actuator 的 5 个方法。

---

## 1. 现有实现

```
deployOne():
  mkdir releases/<id> → uploadFile(产物) → tar -xzf → ln -sfn current → restart → curl 健康检查 → 失败切回 previous
```

（`packages/dsh-cicd/lib/deploy.js`）

能做：单机、整包、软链切版本、失败自动回退、`keep` 清理。
不能做：

- 多实例（一台机跑多个进程/端口/权重）；
- 分阶段切流（stage 完就 `current` 切换，中间没有「全部准备好再接流量」）；
- 容器与 K8s；
- 部署前的迁移/预热顺序控制；
- 观察窗判定（只有单点 HTTP 探针，没有错误率/延迟）；
- 回滚所需的完整现场（pid/端口/镜像 digest/迁移标记）。

---

## 2. 统一抽象

```
deploy(artifact_digest, target, release_config) → release

1. stage    把字节送到每台主机/每个槽位，不接流量
2. activate 切流量（改 current / 起新容器 / patch Deployment）
3. verify   L1 进程 → L2 readiness → L3 观察窗
4. commit   清理旧版本、写 manifest；失败则 abort → 补偿回滚已激活的主机
```

**Actuator 接口**（形态差异的唯一落点）：

```ts
interface Actuator {
  stage(release: Release, host: Host, slots: Slot[]): Promise<StagedHandle>
  activate(handle: StagedHandle, plan: ActivationPlan): Promise<void>   // 切流量
  health(handle: StagedHandle): Promise<HealthReport>                   // L1+L2
  stop(handle: StagedHandle, drain: DrainSpec): Promise<void>           // 先停流量再 SIGTERM
  cleanup(handle: StagedHandle, keep: number): Promise<void>
}
```

能共用 release/rollback 语义（同一张表、同一 manifest、同一判据、同一 UI），**不能共用激活实现**。把 K8s 塞进 symlink 语义只会做出假的滚动发布。

| | native | container | k8s |
|---|---|---|---|
| stage | 解包 `releases/<id>/` | `docker pull repo@sha256:…` | 改 image 为 digest |
| activate | symlink 原子换 + restart | 起新容器 + proxy 切流 | patch Deployment / Rollout |
| rollback | 指回 previous + restart | 换回旧 digest | `rollout undo` |
| 批次归属 | 我们按 host | 我们按 host | 控制器 `maxSurge`/`maxUnavailable` |

---

## 3. 三级模型：Target → Host → Instance

**Instance 不是「副本数」，它绑定端口、权重、健康与日志**——这才是「多实例」与「多主机」的真正含义。

```yaml
targets:
  prod:
    mode: native                   # native | container | k8s
    strategy: rolling              # serial | parallel | rolling | canary | blue-green
    hosts:
      - { name: prod-1, address: 10.0.0.11, max_instances: 4 }
      - { name: prod-2, address: 10.0.0.12, max_instances: 4 }
    instances:
      count: 6                     # 均摊 prod-1:3 / prod-2:3
      port: { base: 8080, step: 1 } # 8080..8085，落盘 slot 锁
      weight: 100                   # 期望值，由流量层 reconcile
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

- **端口分配**：`O_EXCL` 写 `slots/<host>/<port>.lock`（含 pid + release），启动时按 pid 存活与端口探测回收僵尸锁；容器用 `-p 0` 让 docker 分配，再 `docker port` 读回。
- **权重**：只存在于流量层（kamal-proxy / nginx upstream / Service），DB 存期望值，部署后 reconcile 实际值并告警偏差。
- **日志**：native 走 `app@<slot>.service` + journald 或 per-instance 文件；容器 `docker logs --since`；统一 `log_path` 供面板聚合。
- **顺序**：全部主机先 `stage`（不接流量）→ 统一 `activate` → 逐台 verify → commit；任一台失败只回滚已激活的机器（补偿事务），未激活的直接清理。

---

## 4. 五种策略

| 策略 | 行为 | 适用 | 关键参数 |
|---|---|---|---|
| `serial` | 一台一台部署并验证 | 单实例、无流量层 | `onHostFailure: stop` |
| `parallel` | 全部主机同时 | 无状态、可容忍短抖动 | `maxParallel` |
| `rolling` | 分批，批内并行，批间验证 | 默认 | `batch = maxUnavailable`（默认 25%） |
| `canary` | 先 1 台/N%，观察，再逐步放大 | 有流量层 | `steps: [5,25,50,100]`，每步 ≥5min 且 ≥1000 请求 |
| `blue-green` | 新组全绿再切 100%，旧组留 T 分钟 | 可双倍资源 | `keepOldFor` |

参考：Ansible `serial`/`strategy: free`/`max_fail_percentage`（<https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_strategies.html>）；K8s RollingUpdate 默认 25%（<https://kubernetes.io/docs/concepts/workloads/controllers/deployment/>）；Argo Rollouts canary/analysis（<https://argo-rollouts.readthedocs.io/en/stable/features/canary/>）。

---

## 5. 判定规则（三层探针）

| 层级 | 内容 | 失败动作 |
|---|---|---|
| L1 | 进程存活、端口监听 | abort |
| L2 readiness | HTTP 200 + body 匹配 + 依赖 ping（DB/Redis） | abort + 回滚 |
| L3 观察窗 | 60s 内 5xx > 5% 或 p95 > 2× 基线 或 健康实例 < N-1 | 自动回滚 |

| 参数 | 默认 |
|---|---|
| L2 成功 | 5 次 × 2s 内成功 |
| L2 失败 | 连续 2 次或 12s 超时 |
| L3 窗口 | 60s |
| 单机超时 | 300s |
| 整批超时 | 900s |

**优雅停机顺序（不可省）**：先停流量 → 等 `drain.delay`（≥2× 健康检查间隔）→ `SIGTERM` → 等 `timeout` → `SIGKILL`。
K8s 里端点停用与 SIGTERM 并行，必须配 `preStop: sleep`（<https://kubernetes.io/docs/concepts/workloads/pods/pod-termination/>）。

---

## 6. 回滚凭什么可靠

回滚前**必须已持久化**（缺一不可）：

1. 上一 release id + **digest**（不是 tag）；
2. 每主机 `current` / `previous` 指针；
3. 每 instance 的 `host/slot/port/pid/container_id`；
4. 激活前的 unit / compose / env 快照；
5. 健康检查配置快照；
6. 迁移标记与版本号；
7. 权重与 proxy 配置版本；
8. 部署锁与操作者。

manifest 同时写 `releases/<id>/.dsh-manifest.json` 与 DB，**离线可读**（主机失联时运维能照着手工回滚）。

参考实现：Capistrano 的 `releases/` + `current` + `shared/`（<https://capistranorb.com/documentation/getting-started/structure/>）；Kamal 由 proxy 持流量——起新容器→探活→切流→旧容器 drain（<https://kamal-deploy.org/docs/configuration/proxy/>）；Dokku 等 checks 窗口再切流（<https://dokku.com/docs/deployment/zero-downtime-deploys/>）。

---

## 7. 非线性的部署步骤

不要塞进 shell 脚本，用 **stage 类型** 表达：

| stage | 语义 | 失败处理 |
|---|---|---|
| `migrate(expand)` | 加列/加表，向后兼容 | 失败即 abort，未切流量 |
| `deploy` | 切流量 | 回滚 |
| `warmup` | 预热缓存/连接池 | 只告警 |
| `smoke` | 关键路径冒烟 | 触发回滚 |
| `migrate(contract)` | 删旧列，下一版执行 | 不可回滚，roll forward |

**迁移不可回滚，只能 roll forward**：expand/contract 两阶段 + `irreversible: true` 标记 + 默认 `manual` 确认。

---

## 8. 失败模式

| 症状 | 根因 | 对策 |
|---|---|---|
| 回滚后行为变了 | 按 tag 回滚，tag 已漂移 | 只按 digest 回滚 |
| 切换后仍 502 | symlink 换了但进程未重启/持旧 fd | activate 必含 restart 或 socket activation |
| 探针过但接口 500 | 探针不含依赖 | readiness 加依赖 ping + smoke |
| 半数主机成功 | 无全局事务 | per-host 状态表 + 补偿回滚 + 幂等重试 |
| 新实例起不来 | 僵尸进程占端口 | slot 锁 + pid/端口探测回收 |
| 产物损坏 | 磁盘满 / 半包 | 流式 sha256 + `.tmp` rename + 空间预检 |
| 回滚后数据错乱 | 迁移已执行 | irreversible 标记 + expand/contract + 人工 |
| 发布瞬间雪崩 | 缓存冷、资源未预热 | warmup + 版本化资源路径 |
| 长连接被切断 | drain 短于连接寿命 | `drain.delay ≥ 最大请求时长` + preStop |
| 回滚无版本 | `revisionHistoryLimit=0` 或 release 被 GC | 保留 N 个 + pinned 永不删 |
| 并发部署互踩 | 无锁 | 每 target 一把带 TTL 的 deploy lock（**落 DB，不能是进程内 Map**） |
| 拉镜像 401 | registry token 过期 | 部署前 refresh，失败即中止 |

---

## 9. 接口

```jsonc
// cicd_deploy
{ "runId": "…", "target": "prod", "strategy": "rolling", "confirmProd": true }
→ { "releaseId": "rel_7f3a", "state": "activated",
    "hosts": [{ "host": "prod-1", "instances": 3, "slots": [8080,8081,8082], "health": "ok" }] }

// cicd_rollback
{ "target": "prod", "releaseId": "rel_7f3a_prev" } → { "state": "rolled_back", "hosts": [...] }

// cicd_instance_list  → 每 instance 的 host/slot/port/pid/health/log
```

REST：`POST /v1/deployments`、`POST /v1/deployments/:id/rollback`、`GET /v1/targets/:t/instances`。

---

## 10. 验收标准

1. 2 台主机 × 3 实例 = 6 个进程，端口 8080–8085 无冲突，日志分别落盘，面板能按 instance 过滤。
2. 第 2 台 stage 失败 → 第 1 台不得被 activate（全 stage 完成才切流）。
3. 第 2 台 verify 失败 → 第 1 台自动回滚到 previous，最终 6 个实例全部是旧版本。
4. `kill -9` 一个实例后重跑部署 → slot 锁被回收，端口可复用。
5. 回滚只用 digest：把 tag `latest` 指向新 digest 后回滚，仍回到旧字节（断言 `artifact_digest` 未变）。
6. 容器模式 `docker inspect` 显示镜像为 `@sha256:` 形式，非 `:tag`。
7. 断网状态可从 `.dsh-manifest.json` 读出完整回滚现场。
