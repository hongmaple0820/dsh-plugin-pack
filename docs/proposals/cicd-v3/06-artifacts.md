# 06 · 制品库与制品流转（Artifacts）

> 回答的问题：**「制品库怎么定义和接入？Maven 依赖怎么来？部署的到底是源码还是制品？」**
> 结论：**制品是一等公民，但必须把 artifact（字节）与 release（部署意图）分成两层。**
> 只存 tag 的系统无法保证「回滚到同一份字节」——tag 是可变指针。

---

## 1. 现有实现的问题

| 现状 | 问题 |
|---|---|
| `deployStep` 里 `artifactFor(project, step.deploy.artifacts)` 在项目目录 glob 找文件（`index.js:483`） | 产物是「构建完工作区里恰好存在的文件」，不是不可变对象；同一 commit 重跑可能得到不同字节 |
| `recordArtifact` 只写 `artifacts(path,bytes,sha256)`（`lib/db.js`） | 没有 CAS、没有引用计数、没有跨 run 复用；`releases.artifact_sha256` 是唯一关联，但产物本体仍留在工作区 |
| 无依赖仓库 | Maven/npm/PyPI 依赖直连公网，无法离线、无法审计、无法阻止投毒 |
| 无 promotion | 「dev 验证过的字节」与「prod 部署的字节」之间没有可验证的同一性 |

---

## 2. 数据模型

```sql
-- 字节层：内容寻址，不可变
CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,          -- sha256 前 16 位，便于人读
  digest        TEXT NOT NULL UNIQUE,      -- sha256:<64hex>
  size          INTEGER NOT NULL,
  media_type    TEXT NOT NULL,             -- application/gzip, application/zip, application/vnd.oci.image.manifest.v1+json …
  kind          TEXT NOT NULL,             -- generic-tar | maven | npm | pypi | oci-image | oci-artifact
  blob_path     TEXT NOT NULL,             -- cas/sha256/ab/cdef…
  run_id        TEXT,
  commit_sha    TEXT,
  provenance    TEXT,                      -- JSON：builder 镜像 digest、构建参数 hash、SBOM digest、签名
  retention     TEXT NOT NULL DEFAULT 'default',   -- default | pinned | ephemeral
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

-- 命名层：可变指针，只用于人读与兼容生态
CREATE TABLE tags (
  repo     TEXT NOT NULL,
  tag      TEXT NOT NULL,
  digest   TEXT NOT NULL,
  mutable  INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, tag)
);

-- 晋级层：跨环境移动「意图」，不复制字节
CREATE TABLE promotions (
  id         TEXT PRIMARY KEY,
  digest     TEXT NOT NULL,
  from_env   TEXT, to_env TEXT NOT NULL,
  approved_by TEXT, approved_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 部署层：见 07-deploy.md
CREATE TABLE releases (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, env TEXT NOT NULL,
  artifact_digest TEXT NOT NULL, mode TEXT NOT NULL,       -- native | container | k8s
  config_hash TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, activated_at INTEGER, superseded_by TEXT
);
```

**三条不变量：**

- **I1**：`releases.artifact_digest` 必填且必须存在于 `artifacts`；不存在则拒绝创建 release。
- **I2**：tag → digest 的解析只发生一次（构建/晋级时），部署与回滚**只用 digest**。
- **I3**：GC 只删「已软删 + refcount=0 + 无任何 release/tag/promotion 引用」的 blob。

---

## 3. 存储布局

```
<workDir>/artifacts/
  cas/sha256/ab/cdef0123…            # 唯一写入点：.tmp → fsync → rename
  index.sqlite                       # artifacts / tags / promotions / referrers
  trash/<digest>/                    # 软删，7 天后硬删
  tmp/
```

- 写入：流式接收 → 边收边算 sha256 → 与声明值比对 → `.tmp` 落盘 → `rename`。**内容寻址目录名即校验和**，幂等天然成立。
- 读取：`GET /cas/sha256/<digest>`，支持 `Range`、`ETag`、`Cache-Control: immutable`。
- 去重：同一 digest 只存一份；上传已存在返回 `200` 而非 `409`。

---

## 4. 单一写入入口 + 只读分发

**不做 Nexus 的克隆，做「本地 CAS + 只读 HTTP + 单一写入口 + OCI 兼容层」**（约 1500 行，可落地）：

| 端点 | 语义 | 实现要点 |
|---|---|---|
| `PUT /api/v1/blobs` | 上传制品 | 流式 sha256；不符 `400 DIGEST_MISMATCH`；已存在 `200` |
| `GET /cas/sha256/<d>` | 下载 | Range/ETag；`immutable` |
| `GET /repository/maven/<groupPath>/<artifact>/<ver>/<file>` | Maven 只读仓库 | 布局照 Maven 规范；`maven-metadata.xml` 由 DB 生成 |
| `GET /repository/npm/<pkg>` | npm packument | `dist.tarball` 指向 CAS；`dist.integrity` 用 SRI `sha512-` |
| `GET /simple/<project>/` | PyPI Simple | 按 `Accept` 在 PEP 503 HTML / PEP 691 JSON 间协商 |
| `GET /v2/…` | OCI Distribution | manifests / blobs / tags/list / referrers |
| `POST /api/v1/promotions` | 晋级 | 校验 digest 在同环境已有成功 release |

- **认证**：沿用 Docker token 流程（`/v2/` 返回 `401` + `WWW-Authenticate: Bearer realm=…,service=…`），换短期 token；Maven/npm/PyPI 用 Basic + 项目级只读 token。
- **上游代理**：可以配置 Nexus/Artifactory/Harbor 作为 pull-through upstream，但**内部一律只认 digest**，不认它们的 tag。
- 兼容性坑（已核实）：
  - GitLab Maven 对「同名同版本」是**追加入已有 package**，不能当不可变源（<https://docs.gitlab.com/user/packages/maven_repository/>）。
  - Harbor 的 tag immutability 必须 2.x **显式开启**，Distribution 上游不强制 tag↔digest 映射（<https://goharbor.io/docs/2.15.0/working-with-projects/working-with-images/create-tag-immutability-rules/>）。
  - OCI 分发规范：<https://github.com/opencontainers/distribution-spec/blob/main/spec.md>。

### 4.1 各生态落盘路径（做兼容层时照抄）

- **Maven**：`<groupId 转路径>/<artifactId>/<version>/<artifactId>-<version>[-classifier].<ext>`，每级目录一个 `maven-metadata.xml`（<https://maven.apache.org/repository/layout.html>）。
- **npm**：`GET /:pkg` 返回 packument（`versions`、`dist-tags`），每版本带 `dist.tarball` + `dist.integrity`（<https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md>）。
- **PyPI**：`GET /simple/<project>/`（PEP 503 / PEP 691）。
- **OCI**：`/v2/<name>/manifests/<tag|digest>`、`/blobs/<digest>`、`/tags/list`、`/referrers/<digest>`。任意文件可用 ORAS 打成 OCI artifact，签名/SBOM 走 referrers（<https://oras.land/docs/>）。

---

## 5. 依赖仓库怎么接（回答「Maven 依赖从哪来」）

构建时**不允许直连公网**，全部走内部仓库；`toolchain` 与 `artifact repo` 是两件事：

```yaml
# pipe.yml
variables:
  MAVEN_OPTS: -Dmaven.repo.local=${RUN_DIR}/m2
cache:
  - key: m2-${{ hashFiles('**/pom.xml') }}
    paths: [".m2"]
repositories:                     # 项目级，Admin 可改
  maven:
    mirror: "https://cicd.internal/repository/maven"   # 覆盖 central
    releases: true
    snapshots: false
  npm:
    registry: "https://cicd.internal/repository/npm/"
  pypi:
    index: "https://cicd.internal/simple/"
```

- **写** `<workDir>/runs/<runId>/settings.xml` 注入 `-s`，而不是改全局 `~/.m2/settings.xml`；Gradle 写 `init.gradle` 的 `repositoriesMode`；npm 写项目级 `.npmrc`；pip 用 `PIP_INDEX_URL`。
- **发布**：`mvn deploy -DaltDeploymentRepository=internal::default::https://cicd.internal/repository/maven`，凭证来自 secret，不进日志。
- 依赖缓存键：lock 文件 sha256 前 16 位；只缓存下载物，不缓存 `site-packages`/`node_modules` 本体（见 05 §5）。

---

## 6. 晋级（promotion）而不是「重新构建」

```
build → artifact(digest) → deploy dev → smoke → promote(staging, digest) → deploy staging
      → 人工审批 → promote(prod, digest) → deploy prod
```

- promotion **只写一行记录 + 移动环境指针**，不复制字节、不重新构建。
- 生产部署前校验：`digest` 与 staging 上验证过的 `digest` 相同；不同则拒绝（`ARTIFACT_NOT_PROMOTED`）。
- 这样才真正回答「prod 跑的是哪个版本」：`SELECT digest FROM promotions WHERE to_env='prod' ORDER BY approved_at DESC LIMIT 1`。

---

## 7. 保留与回收

| 类别 | 默认 | 规则 |
|---|---|---|
| `pinned` | 永久 | 任何被 release 引用过的 digest；删 release 也不行，需显式 unpin |
| `default` | 90 天 | 无引用后软删 → 7 天 → 硬删 |
| `ephemeral` | 7 天 | PR 构建产物 |

- GC 命令：`cicd artifact gc --dry-run` 先出报告（将删哪些、释放多少），确认后执行。
- 参考：Nexus cleanup policy + compact blob store（<https://help.sonatype.com/en/cleanup-policies.html>）；Harbor tag retention（<https://goharbor.io/docs/2.15.0/working-with-projects/working-with-images/create-tag-retention-rules/>）。

---

## 8. 工具与接口

```jsonc
// cicd_artifact_upload  （job 内使用，由 runner 调用）
{ "runId": "20261118-131500-a1b2c3", "path": "target/shop-api-1.4.2.jar", "kind": "maven" }
→ { "digest": "sha256:8b9b…", "size": 19359470, "reused": false }

// cicd_artifact_promote
{ "digest": "sha256:8b9b…", "toEnv": "prod", "approvalId": "ap_9f2c" }
→ { "promotionId": "pr_71ab", "env": "prod" }

// cicd_artifact_list / gc / pin
```

REST：`POST /api/v1/blobs`、`GET /cas/sha256/:digest`、`POST /api/v1/promotions`、`GET /api/v1/artifacts?run=…`。

---

## 9. 验收标准

1. 同一 commit 连续构建两次 → 若产物字节一致，`digest` 相同且第二次上传 `reused: true`、磁盘不增长。
2. 上传 1 字节被篡改的包 → `400 DIGEST_MISMATCH`，CAS 不落盘。
3. 删除 staging 的 release 后，prod 的 release 仍可回滚（`pinned` 生效）。
4. Maven 构建在断网 + 内部镜像命中下成功；日志不出现公网 URL。
5. `promote` 到 prod 但 digest 与 staging 不同 → 拒绝，错误码 `ARTIFACT_NOT_PROMOTED`。
6. `GET /v2/<name>/manifests/<digest>` 返回正确 `Docker-Content-Digest`，`docker pull` 可用。
