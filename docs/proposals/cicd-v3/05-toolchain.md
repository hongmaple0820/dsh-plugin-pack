# 05 · 构建环境与工具链（JDK / Maven / Node / Python / PHP / Go）

> 回答的问题：**「JDK 版本这些细节怎么处理？Node 能用 nvm 切、Python 能用 venv 隔离吗？」**
> 结论：可以，但不要依赖 nvm/pyenv/SDKMAN 的 shim 机制——它们假设一个交互式、被 `source` 过的 shell。
> 正确做法是：**把它们当作声明格式的事实标准来「读」，把「解析 → 下载 → 校验 → 注入」自己做。**

---

## 1. 为什么不能直接用 nvm / pyenv / SDKMAN

| 工具 | 致命问题 | 对本项目的后果 |
|---|---|---|
| `nvm` | 纯 bash 函数，靠 `source nvm.sh` 修改**当前 shell** 的 PATH；Windows 版是另一个项目，v1 需要管理员权限 + `SeCreateSymbolicLinkPrivilege` 才能 `nvm use` | 非交互 `spawn` 的子进程拿不到切换结果；Windows 宿主直接不可用 |
| `pyenv` | 从源码编译 CPython，需 gcc/openssl，8–15 分钟 | 每次新 runner 预热 15 分钟，不可接受 |
| `SDKMAN` | 依赖 `sdkman-init.sh` 被 source；候选目录改 PATH | 同上，且只覆盖 JVM 系 |
| `jenv` | 只切换**已安装**的 JDK，不下载 | 宿主没有 JDK 17 就无解 |
| `asdf` | 插件是 bash 脚本、无版本锁、下载无校验；0.16 虽用 Go 重写但生态仍假设 POSIX shell | 可复现性不达标 |
| `volta` | 会劫持全局 `node`，与「不污染宿主」直接冲突 | 违反隔离目标 |

**唯一值得抄的是「声明格式」与「锁文件」思路**：`.tool-versions`/`.nvmrc`/`.python-version` 作为兼容输入，`mise.lock` 的「每平台 URL + checksum」作为锁文件形状（<https://mise.jdx.dev/dev-tools/mise-lock.html>）。

现网证据：`packages/dsh-cicd/lib/runner.js:188` 把 `{ ...process.env, CI:'1', ...vars }` 直接交给 `spawn`，`cwd` 是项目目录（`lib/runner.js:198`）。同一台机器上 JDK17 与 JDK21 两个项目必然互相污染，且构建结果取决于「宿主碰巧装了什么」。

---

## 2. 设计：四段式

```
声明(pipe.yml) → Resolver(spec → 不可变版本 + URL + 校验和)
              → Installer(内容寻址 CAS + 原子提交 + 并发锁)
              → Injector(只改子进程 env，不碰宿主)
              → Verifier(断言版本，fail fast)
```

### 2.1 声明

项目级（`pipe.yml`）：

```yaml
toolchain:
  java:   temurin-17          # vendor-feature 或精确 17.0.11+9
  maven:  3.9.6
  gradle: 8.7                 # 与 maven 二选一，按项目构建工具
  node:   20                  # 20 → 最新 20.x
  python: 3.11
  php:    8.3
  go:     1.22
```

- 只允许 **vendor 枚举 + 版本表达**，**不允许 URL**——pipe.yml 是 PR 可改的，任意 URL 等于任意代码执行。
- 兼容读取：若项目根有 `.nvmrc`/`.node-version`/`.python-version`/`.tool-versions`/`.sdkmanrc`，且 `pipe.yml` 未声明对应项，则作为默认值（`toolchain.infer_from_files: true`，默认开）。
- 机器级只允许配置：镜像源、代理、store 目录、磁盘配额、允许的 vendor 白名单。**机器级不放版本**，否则同一份 pipe.yml 在不同 runner 上跑出不同结果。

### 2.2 解析（Resolver）

- 输入 `spec`（如 `17`、`temurin-17`、`3.9.6`），输出 `{lang, resolved, platforms:{linux-x64:{url,sha256,size}, win32-x64:{…}}, key}`。
- 索引来源带 ETag/TTL 缓存（默认 1h），离线时用缓存；`--frozen` 模式下**只读锁文件，缺条目直接失败**。
- 语义：`17` → 该 feature 线最新补丁（并记录到锁）；`temurin-17` → 指定 vendor；`17.0.11+9` → 精确。

### 2.3 安装（Installer）

- 安装根：`<workDir>/toolchains/store/<lang>/<resolved>/<os>-<arch>/`（Windows 默认 `<workDir>` 也在用户目录，不需要管理员）。
- 下载缓存：`<workDir>/toolchains/downloads/<sha256>/<basename>`，先写 `.part` 再 `rename`。
- 原子提交：解压到 `.tmp-<pid>-<rand>` → 写 `.ok`（含 spec/url/sha256/时间）→ `rename` 到目标目录。
- 并发锁：`mkdir(<lockDir>)` 的原子性做互斥（跨平台可用，不依赖 `flock` 的 Windows 支持）。
- **校验失败一律 fail closed**，绝不覆盖已有 blob（供应链投毒防线）。

```ts
// resolver.ts（示意）
type Resolved = { lang: string; resolved: string; key: string;
  platforms: Record<string, { url: string; sha256: string; size?: number }> }

async function resolve(lang: string, spec: string, plat: string, lock: LockFile): Promise<Resolved> {
  const hit = lock.tool.find(t => t.lang === lang && t.platforms[plat] && satisfies(spec, t.resolved))
  if (FROZEN && !hit) throw new ToolchainError(`lock 缺少 ${lang}@${spec}@${plat}，拒绝联网解析`)
  if (hit) return hit
  const index = await provider[lang].index()            // 带 ETag 缓存
  const version = pickMaxSatisfying(index, spec)
  const platforms = await provider[lang].locate(version) // 所有支持的 os-arch 一次拿全
  return { lang, resolved: version, key: `${lang}/${version}`, platforms }
}

async function ensure(item: Resolved, plat: string): Promise<string> {
  const dir = join(STORE, item.key, plat)
  if (existsSync(join(dir, '.ok'))) return dir
  const unlock = await mkdirLock(join(LOCKS, `install-${slug(item.key)}-${plat}.lock`))
  try {
    if (existsSync(join(dir, '.ok'))) return dir        // 双检
    const p = item.platforms[plat]
    const blob = join(DOWNLOADS, p.sha256, basename(p.url))
    if (!existsSync(blob)) await downloadVerified(p.url, p.sha256, blob)  // .part → rename
    const tmp = join(STORE, `.tmp-${process.pid}-${randomUUID()}`)
    await extract(blob, tmp)                            // tar.gz 保留权限；zip 后补 chmod
    if (process.platform !== 'win32') await chmodExecutables(tmp)
    await writeFile(join(tmp, '.ok'), JSON.stringify({ ...item, platform: plat, at: new Date().toISOString() }))
    await rename(tmp, dir)                              // 同卷原子
    return dir
  } finally { await unlock() }
}
```

### 2.4 注入（Injector）

只构造子进程 `env`，**不写任何 shell rc、不改注册表、不做全局 symlink**：

```ts
function envFor(installed: Installed[], run: RunDirs): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  const bins = installed.map(i => i.binDir)
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,                                  // 只保留白名单变量，不 spread process.env
    PATH: [...bins, baseEnv.PATH].join(sep),     // 前置，压住宿主版本
    CI: '1',
  }
  const java = installed.find(i => i.lang === 'java')
  if (java) { env.JAVA_HOME = java.home; env.MAVEN_OPTS = `-Dmaven.repo.local=${run.m2}` }
  const py = installed.find(i => i.lang === 'python')
  if (py) { env.VIRTUAL_ENV = run.venv; env.PIP_CACHE_DIR = `${run.cache}/pip`; delete env.PYTHONHOME }
  env.NPM_CONFIG_CACHE = `${run.cache}/npm`
  env.GRADLE_USER_HOME = run.gradle
  env.GOCACHE = `${run.cache}/go-build`; env.GOTOOLCHAIN = 'local'
  return env
}
```

三条铁律：

1. `spawn(cmd, args, { env, shell: false })`。Windows 上 `npm`/`mvn` 是 `.cmd`，需 `resolveBin()` 补扩展名，或 `cmd.exe /d /s /c`。
2. Linux 用 `bash --noprofile --norc -c`。非交互 bash **不读** `.bashrc`，只读 `$BASH_ENV`——别指望用户 rc 里的配置生效。
3. 启动后**立刻断言版本**：`java -version` 必须含 `17.`、`node -v` 必须 `v20.`；不匹配直接失败并打印 `PATH`/`JAVA_HOME`。这是防「宿主 JDK 21 静默生效」的唯一可靠手段。

### 2.5 各语言的特殊处理

**Java + Maven**：双重锁定。生成 `$RUN/toolchains.xml` 并用 `mvn -t` 指定，同时 `JAVA_HOME` 指向同一棵树：

```xml
<toolchains><toolchain><type>jdk</type>
  <provides><version>17</version><vendor>temurin</vendor></provides>
  <configuration><jdkHome>/…/store/java/17.0.11+9/linux-x64</jdkHome></configuration>
</toolchain></toolchains>
```

（Maven toolchains 指南：<https://maven.apache.org/guides/mini/guide-using-toolchains.html>）

**Java + Gradle**：Gradle 的 toolchain 优先级里「**运行 Gradle 的 JVM**」优先，所以不能让 daemon 跑在宿主 JDK21 上却声明 17。写 `$RUN/gradle.properties`：

```properties
org.gradle.java.installations.auto-detect=false
org.gradle.java.installations.auto-download=false
org.gradle.java.installations.paths=/…/store/java/17.0.11+9/linux-x64
```

（Gradle toolchains：<https://docs.gradle.org/current/userguide/toolchains.html>）

**Node**：托管模式下直接解压官方 tarball；`source: nvm` 时读取 `$NVM_DIR/versions/node/<v>` 并只注入 PATH（兼容用户已有环境，但不推荐用于远端 runner）。Windows 用 `-win-x64.zip`。

**Python**：解释器用 python-build-standalone（预编译，非源码编译），依赖用 `venv` + `uv`/`pip`：

```
runtime:  store/python/3.11.9/linux-x64/bin/python3
venv:     $RUN/venv            # python -m venv $RUN/venv
install:  $RUN/venv/bin/pip install -r requirements.txt  （或 uv pip sync --frozen）
```

这样「Python 用 venv 隔离」成立：每个 run 一个 venv，`site-packages` 不共享；**依赖缓存**通过 `PIP_CACHE_DIR` 共享（只缓存 wheel，不复用 site-packages），避免 A 项目的包污染 B 项目。

**PHP**：Linux 上没有官方免 root 二进制，推荐容器兜底（`php:8.3-cli`）；Windows 用 `windows.php.net` 的 zip。Composer 单独安装：`https://getcomposer.org/download/<v>/composer.phar` + `.sha256sum`。

**Go**：`GOTOOLCHAIN=local` 必须设，否则 `go` 会自动下载工具链，绕过锁文件。

---

## 3. Provider 配方（URL 与校验）

| 语言 | 索引 | 下载 | 校验 |
|---|---|---|---|
| Java | `GET https://api.adoptium.net/v3/assets/latest/{feature}/hotspot?architecture={arch}&image_type=jdk&os={os}&vendor=eclipse` → `version.semver`、`binary.package.link`、`binary.package.checksum` | 响应里的 GitHub release 直链 | 响应内 sha256；另有 `.sha256.txt`、`.sig` |
| Maven | `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml` | `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.tar.gz`（永久归档；CDN `dlcdn.apache.org`） | 同目录 `.sha512` |
| Gradle | `https://services.gradle.org/versions/all` | `https://services.gradle.org/distributions/gradle-8.7-bin.zip` | `.sha256` |
| Node | `https://nodejs.org/dist/index.json` | `https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz`（win `-win-x64.zip`） | `SHASUMS256.txt` 按文件名匹配 |
| Python | python-build-standalone releases（`astral-sh/python-build-standalone`） | `cpython-3.11.9+20240415-x86_64-unknown-linux-gnu-install_only.tar.gz`（win `x86_64-pc-windows-msvc-shared-install_only`） | 附件 `.sha256` |
| PHP | `windows.php.net/downloads/releases/`（Win）；Linux 走容器 | `php-8.3.x-nts-Win32-vs16-x64.zip` | `sha256sum.txt` |
| Go | `https://go.dev/dl/?mode=json` | `https://go.dev/dl/go1.22.5.linux-amd64.tar.gz` | JSON 内 `files[].sha256` |

> 实现时以官方响应为准，**不要硬编码 checksum**；checksum 只进锁文件。

---

## 4. 锁文件

`pipe.lock`（JSON，放项目根，随仓库提交）：

```json
{
  "version": 1,
  "toolchain": [
    {
      "lang": "java", "spec": "temurin-17", "resolved": "17.0.11+9",
      "platforms": {
        "linux-x64":  { "url": "https://github.com/adoptium/.../OpenJDK17U-jdk_x64_linux_hotspot_17.0.11_9.tar.gz", "sha256": "8b9b…8711", "size": 193594705 },
        "win32-x64":  { "url": "https://github.com/adoptium/.../OpenJDK17U-jdk_x64_windows_hotspot_17.0.11_9.zip", "sha256": "…", "size": 187000000 }
      }
    }
  ],
  "pipelines": { "default": "sha256:9f2c…" }
}
```

规则：

- **一个平台一条 URL + checksum**——这就是「Windows 宿主 + Linux runner 共用同一份声明」的方式：声明只写 `temurin-17`，锁按 `os-arch` 展开。
- `spec` 可滚动，`resolved` 不可变。
- 构建默认 `--frozen`（有锁必须命中）；更新只经 `cicd_toolchain_lock --bump java` 产生 diff → 人工审阅。
- 锁文件缺失时：本地开发可自动生成并提示提交；CI/远端 runner 直接失败。

---

## 5. 缓存

| 缓存 | 键 | 目录 | 说明 |
|---|---|---|---|
| Maven | `hashFiles('**/pom.xml')` 的 sha256 前 16 位 | `<cache>/m2/<key>` | 只读基线 + 本次可写；`-Dmaven.repo.local` |
| Gradle | `hashFiles('**/*.gradle*','**/gradle-wrapper.properties')` | `<cache>/gradle/<key>` | `GRADLE_USER_HOME`，`--no-daemon` |
| npm/pnpm | `hashFiles('**/package-lock.json','**/pnpm-lock.yaml')` | `<cache>/npm/<key>` | `NPM_CONFIG_CACHE` / `pnpm store` |
| pip/uv | `hashFiles('**/requirements*.txt','**/uv.lock','**/pyproject.toml')` | `<cache>/pip/<key>` | 只存 wheel，不存 site-packages |
| Composer | `hashFiles('**/composer.lock')` | `<cache>/composer/<key>` | `COMPOSER_CACHE_DIR` |
| Go | `hashFiles('**/go.sum')` | `<cache>/go/<key>` | `GOMODCACHE` + `GOCACHE` |

并发安全：缓存目录进入前加 `.lock`；写入用「临时目录 + 原子 rename」，半写状态不可见。淘汰：按「最近使用 + 大小」LRU，默认上限 `cache.maxBytes`（建议 20GB），`cicd cache gc` 可手动清。

> 不共享 `site-packages` / `node_modules` 本体，只共享**下载缓存**。共享依赖树是「A 项目删了 B 项目的包」这类幽灵故障的根源。

---

## 6. 失败模式与处置

| 症状 | 根因 | 处置 |
|---|---|---|
| 下载 403/429 | GitHub release 匿名限流、企业代理拦 UA | 镜像源优先、带 token、指数退避、预置 tarball |
| checksum 不匹配 | 上游替换资产 / 镜像内容不同 / 锁跨平台错配 | **fail closed**；只刷新单条锁并 review |
| 磁盘满 | store 无界增长 | 安装前 `statfs` 预检（预留 ≥2× 包大小）；LRU + 配额 |
| 并发安装竞争 | 两个 job 装同一版本 | `mkdir` 原子锁 + 临时目录 + `rename` |
| PATH 污染 | 宿主已装别的版本 | PATH 前置 + 版本断言 + 清理 `JAVA_HOME`/`PYTHONHOME`/`VIRTUAL_ENV` |
| `.bashrc` 不生效 | 非交互 shell | 显式 `env`；必要时生成 `$RUN/env.sh` 让脚本 `source` |
| Windows 无 symlink 权限 | 缺 `SeCreateSymbolicLinkPrivilege` | 用 `'junction'`，或不用链接直接拼绝对路径 |
| 可执行位丢失 | zip 无 POSIX mode | Linux 一律 `tar.gz`；解压后 `chmod 0755` |
| Maven 本地仓库损坏 | 多 job 并发写共享 `~/.m2` | 每 run 独立 `repo.local`；共享只读基线 |
| 构建期自动下载逃逸 | Gradle auto-download / `GOTOOLCHAIN=auto` / wrapper 拉 dist | 全关；wrapper distribution 预置进 `GRADLE_USER_HOME/wrapper/dists` |
| 需要 root 的系统库（PHP 扩展、libc） | 宿主缺 dev 包 | 容器兜底（见下） |

**容器兜底**：`eclipse-temurin:17-jdk-jammy`、`maven:3.9.6-eclipse-temurin-17`、`gradle:8.7-jdk17`、`node:20.11-bookworm`、`python:3.11-slim`、`php:8.3-cli`、`golang:1.22`。
挂载 workspace + 缓存；`-u $(id -u):$(id -g)` 做 UID 映射，否则产物属主是 root，回写失败。

官方镜像 tag 策略见 <https://github.com/docker-library/official-images>、Temurin 容器 <https://adoptium.net/installation/container/>。

---

## 7. 预热与离线

按性价比排序：

1. 镜像源（国内直连 GitHub release 是主要瓶颈）。
2. Runner 常驻 `downloads/` 预热（`cicd toolchain prefetch --lock`，随镜像烘焙）。
3. 离线包：`store/<key>` 打 tar 放内网对象存储，`DSH_OFFLINE=1` 时只从本地/内网取。
4. 跨 job 共享 store（同机天然共享；多机用 NFS/rsync 只读基线）。
5. 容器镜像层缓存——`docker pull` 常比多次跨国下载快一个量级。

---

## 8. 接口

工具（给 Agent/CLI）：

```jsonc
// cicd_toolchain_resolve
{ "project": "shop-api", "spec": { "java": "17", "maven": "3.9.6" } }
→ { "resolved": [{ "lang": "java", "spec": "17", "version": "17.0.11+9", "platform": "linux-x64", "url": "…", "cached": true }] }

// cicd_toolchain_install
{ "project": "shop-api", "platform": "linux-x64" } → { "installed": ["java/17.0.11+9"], "bytes": 193594705 }

// cicd_toolchain_list / gc / prefetch
```

REST：`GET/POST /v1/projects/:id/toolchain/{resolve,install,lock,gc}`。

---

## 9. 验收标准

> **实施状态（2026-11-19，v3.0.0-p2）：已交付。** 实现落在 `packages/dsh-cicd/lib/toolchain.js`
> （解析 / 下载 / 校验 / 解包 / 注入 / 断言），接线在 `index.js` 的 `prepareToolchain()` 与
> `lib/runner.js` 的 `toolchainEnv`。下面的六条判据已写成可执行测试
> （`test/smoke.mjs` 的 `P2-S1`…`P2-S7`、`P2-S1b`），逐条对应关系见文末「验收对照」。
>
> 三处与设计不同的地方（都是有意收窄，不是没做完）：
> - **不用 nvm/pyenv/SDKMAN**：它们靠 `source` 改交互式 shell 的 PATH，而我们是
>   `spawn(shell:true)` 的非交互子进程，拿不到被 source 过的状态；只抄了它们的声明格式与锁文件思路。
> - **pipe.yml 里不允许写 URL**，只接受 `vendor+版本`（`temurin-17`、`20.11.1`）。放开 URL
>   等于让任何有提交权限的人指定构建机去下载并执行任意二进制。内网镜像走框架级配置
>   （`file:///opt/mirror/...`），不经过仓库文件。
> - **`php` 没有可移植的官方预编译包**，provider 直接报 `TOOLCHAIN_NOT_FOUND` 并提示用容器；
>   其余六门语言（java/maven/gradle/node/python/go）都有真实下载地址。

1. 宿主只装 JDK 21，项目声明 `java: temurin-17` → `mvn -v` 输出 `Java version: 17.0.11`，且 `echo $JAVA_HOME` 在构建后（父 shell）**未改变**。
2. 同一 runner 并发两个 job（JDK17 与 JDK21）→ 两者产物 `class` 文件主版本分别为 61 与 65，互不污染。
3. 断网 + 锁文件命中 → 构建成功；断网 + 锁缺失 + `--frozen` → 立即失败并给出缺失条目。
4. 篡改下载包（改 1 字节）→ 校验失败且不写入 store。
5. Windows 宿主 + Linux runner 同一份 `pipe.yml` → 两边都能构建，锁文件包含两个平台条目。
6. 二次构建（缓存命中）→ Maven 依赖下载耗时为 0，日志显示 `cache hit: m2/<key>`。

### 验收对照（实际落地的测试）

| 判据 | 测试 | 实际断言 |
| --- | --- | --- |
| ①宿主只有 JDK21、声明 17 | `P2-S1` | 注入的是 17.0.11+9；`process.env.JAVA_HOME` 一个字节没变；子进程能看到注入值；`assertVersions` 对不上时返回「版本不符」 |
| ②并发两个 job 各要 17/21 | `P2-S2` | 两份独立的 store 目录、两个 run 都成功，日志 A 不含 `21.0.2`、B 不含 `17.0.11` |
| ③断网 + 锁命中 / 缺锁 + frozen | `P2-S3` | 命中时 `fromLock=true`；缺锁且 frozen 时 `TOOLCHAIN_LOCK_MISSING` 且**一次索引都没问**（`fetched===0`） |
| ④篡改包 | `P2-S4` | `TOOLCHAIN_CHECKSUM`，store 未写入，坏包被删除，`.downloads` 里不留 `.part` |
| ⑤双平台锁 | `P2-S5` | 一条锁条目带 `linux-x64` 与 `win32-x64` 两个键，切平台后离线 + frozen 仍能命中 |
| ⑥二次构建命中 | `P2-S6` | 第二次 `cached=true` 且 root 相同；把 `.downloads` 整个删掉再装依然成功（证明没有重新下载） |
| 端到端 | `P2-S7` | `/run` 在工具链准备失败时返回 200 + `status:failed` + `code`，DB 里有 failed 的 run，日志显示「准备工具链」且**不含**后续 step 的输出 |
| Maven/Gradle 双锁 | `P2-S1b` | `toolchains.xml` 的 `<version>` 写补丁位（`17.0.11` 而不仅是 `17`）；`gradle.properties` 带 `auto-detect=false` |

> 判据 6 的原始表述是「Maven 依赖下载耗时为 0」。落地时它被拆成两半：工具链层面的
> 「二次安装不重新下载」由 `P2-S6` 覆盖；Maven 依赖缓存（`~/.m2` 复用）属于 `uses: cache`
> 的职责，由 `P2-S9` 覆盖（路径 `~/.m2/repository` 走 home 作用域，落在 `workDir/cache` 下）。
