#!/usr/bin/env node
// DSH 插件包 · SSH/SFTP/隧道 MCP 服务器
// 设计原则：文本优先（省 token、秒级延迟），RDP 截图类视觉控制不在此包范围。
// 协议通道是 stdout，所有诊断一律走 stderr，绝不污染协议流。

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { z } from "zod";
import { Client } from "ssh2";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOSTS_PATH = process.env.DSH_SSH_HOSTS || join(HERE, "hosts.json");

// ---------- 输出上限：保护上下文窗口（token 经济性是本包的核心卖点） ----------
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;
const MAX_SHELL_READ = 32 * 1024;
const MAX_SFTP_GET = 64 * 1024;
const SHELL_BUFFER_MAX = 256 * 1024;

// ---------- 主机配置 ----------
function loadHosts() {
  if (!existsSync(HOSTS_PATH)) return { hosts: {}, configError: "hosts.json 不存在: " + HOSTS_PATH };
  try {
    const parsed = JSON.parse(readFileSync(HOSTS_PATH, "utf8"));
    return parsed && typeof parsed === "object" && parsed.hosts ? parsed : { hosts: {}, configError: "hosts.json 缺少 hosts 字段" };
  } catch (error) {
    return { hosts: {}, configError: "hosts.json 解析失败: " + error.message };
  }
}

// 主机引用：别名（hosts.json）或 user@host[:port]（仅密钥认证——密码绝不内联进参数，避免落进对话记录）
function resolveHost(ref) {
  const entry = (loadHosts().hosts || {})[ref];
  if (entry) {
    if (entry.disabled) throw new Error(`主机别名 "${ref}" 已禁用：${entry.note || "无说明"}`);
    return {
      key: ref, host: entry.host, port: entry.port || 22, user: entry.user,
      password: entry.passwordEnv ? process.env[entry.passwordEnv] : entry.password,
      privateKeyPath: entry.privateKeyPath, note: entry.note,
    };
  }
  const inline = /^(?:([^@\s]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/.exec(ref);
  if (inline) return { key: ref, host: inline[2], port: Number(inline[3] || 22), user: inline[1] || "root", inline: true };
  throw new Error(`未知主机 "${ref}"：不是 hosts.json 别名，也不是 user@host[:port] 形式；可用别名用 hosts_list 查`);
}

function loadDefaultKey() {
  for (const name of ["id_ed25519", "id_rsa"]) {
    const path = join(homedir(), ".ssh", name);
    if (existsSync(path)) { try { return readFileSync(path); } catch { /* 读不了就跳过 */ } }
  }
  return null;
}

// ---------- 连接池：同主机复用 TCP+SSH 连接，keepalive 保活 ----------
const pool = new Map();
const pending = new Map();

function connect(spec, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const options = { host: spec.host, port: spec.port, username: spec.user, readyTimeout: timeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 4 };
    if (spec.password) options.password = spec.password;
    else if (spec.privateKeyPath) {
      if (!existsSync(spec.privateKeyPath)) return reject(new Error(`私钥文件不存在: ${spec.privateKeyPath}`));
      options.privateKey = readFileSync(spec.privateKeyPath);
    } else {
      const key = loadDefaultKey();
      if (!key) return reject(new Error(`主机 ${spec.key} 无凭据：在 hosts.json 配 password / passwordEnv / privateKeyPath`));
      options.privateKey = key;
    }
    const client = new Client();
    const timer = setTimeout(() => { client.end(); reject(new Error(`连接 ${spec.host}:${spec.port} 超时（${timeoutMs}ms）`)); }, timeoutMs + 5000);
    client.on("ready", () => { clearTimeout(timer); pool.set(spec.key, client); resolve(client); });
    client.on("error", (error) => { clearTimeout(timer); pool.delete(spec.key); reject(new Error(`SSH ${spec.host}:${spec.port} 失败: ${error.message}`)); });
    client.on("close", () => pool.delete(spec.key));
    client.connect(options);
  });
}

async function getConnection(ref) {
  const spec = resolveHost(ref);
  if (pool.has(spec.key)) return pool.get(spec.key);
  if (pending.has(spec.key)) return pending.get(spec.key);
  const promise = connect(spec).finally(() => pending.delete(spec.key));
  pending.set(spec.key, promise);
  return promise;
}

// ---------- exec ----------
function sshExec(client, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(new Error("exec 失败: " + error.message));
      let stdout = "", stderr = "", stdoutTruncated = false, stderrTruncated = false;
      stream.on("data", (chunk) => { if (stdout.length < MAX_STDOUT) stdout += chunk.toString("utf8"); else stdoutTruncated = true; });
      stream.stderr.on("data", (chunk) => { if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8"); else stderrTruncated = true; });
      const timer = setTimeout(() => { try { stream.signal("KILL"); } catch { stream.close(); } }, timeoutMs);
      stream.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal: signal || null, stdout, stderr, stdoutTruncated, stderrTruncated });
      });
    });
  });
}

// ---------- 交互式 shell 会话 ----------
const shells = new Map();
let shellSeq = 0;

function openShell(client) {
  return new Promise((resolve, reject) => {
    client.shell({ term: "xterm-256color", cols: 120, rows: 40 }, (error, stream) => {
      if (error) return reject(new Error("打开 shell 失败: " + error.message));
      const id = "sh" + ++shellSeq;
      const session = { id, stream, buffer: "", closed: false, openedAt: new Date().toISOString() };
      stream.on("data", (chunk) => {
        session.buffer += chunk.toString("utf8");
        if (session.buffer.length > SHELL_BUFFER_MAX) session.buffer = session.buffer.slice(-SHELL_BUFFER_MAX);
      });
      stream.on("close", () => { session.closed = true; shells.delete(id); });
      shells.set(id, session);
      resolve(session);
    });
  });
}

async function shellWrite(id, input, waitMs) {
  const session = shells.get(id);
  if (!session) throw new Error(`shell 会话 ${id} 不存在（可能已关闭）；先 ssh_shell_open`);
  session.buffer = ""; // 语义：返回本次写入之后到达的输出
  session.stream.write(input);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const output = session.buffer.length > MAX_SHELL_READ ? session.buffer.slice(0, MAX_SHELL_READ) + "\n…(截断)" : session.buffer;
  return { output, closed: session.closed };
}

// ---------- SFTP ----------
function sftpOf(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => (error ? reject(new Error("SFTP 通道失败: " + error.message)) : resolve(sftp))));
}

function sftpLs(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error) return reject(new Error("readdir " + path + " 失败: " + error.message));
      resolve(list.map((item) => ({
        name: item.filename,
        isDir: (item.attrs.mode & 0o170000) === 0o040000,
        size: item.attrs.size,
        mtime: new Date(item.attrs.mtime * 1000).toISOString(),
      })));
    });
  });
}

function sftpGet(sftp, path, maxSize) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (statError, stats) => {
      if (statError) return reject(new Error("stat " + path + " 失败: " + statError.message));
      const size = stats.size;
      const read = Math.min(size, maxSize);
      if (read <= 0) return resolve({ content: "", size, truncated: size > 0 });
      const chunks = [];
      const stream = sftp.createReadStream(path, { start: 0, end: read - 1 });
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", (error) => reject(new Error("读取 " + path + " 失败: " + error.message)));
      stream.on("close", () => resolve({ content: Buffer.concat(chunks).toString("utf8"), size, truncated: size > read }));
    });
  });
}

function sftpPut(sftp, path, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on("error", (error) => reject(new Error("写入 " + path + " 失败: " + error.message)));
    stream.on("close", () => resolve({ written: true, bytes: Buffer.byteLength(content) }));
    stream.end(content);
  });
}

// ---------- 本地端口转发隧道 ----------
const tunnels = new Map();
let tunnelSeq = 0;

function openTunnel(client, remoteHost, remotePort, localPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      client.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (error, channel) => {
        if (error) { socket.destroy(); return; }
        socket.pipe(channel);
        channel.pipe(socket);
        socket.on("error", () => channel.end());
        channel.on("error", () => socket.destroy());
        socket.on("close", () => channel.end());
        channel.on("close", () => socket.end());
      });
    });
    server.on("error", (error) => reject(new Error("本地监听失败: " + error.message)));
    server.listen(localPort, "127.0.0.1", () => {
      const id = "tn" + ++tunnelSeq;
      const record = { id, server, remoteHost, remotePort, localPort: server.address().port, connections: 0 };
      tunnels.set(id, record);
      resolve(record);
    });
  });
}

// ---------- MCP 工具注册 ----------
const server = new McpServer({ name: "dsh-ssh", version: "0.1.0" });

const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const fail = (error) => ({ content: [{ type: "text", text: String(error && error.message ? error.message : error) }], isError: true });

server.registerTool("hosts_list", {
  title: "列出主机",
  description: "列出 hosts.json 里配置的 SSH 主机别名（密码已脱敏）。先调它看有哪些可用主机。",
  inputSchema: {},
}, async () => {
  const config = loadHosts();
  const hosts = Object.entries(config.hosts || {}).map(([alias, entry]) => ({
    alias, host: entry.host, port: entry.port || 22, user: entry.user,
    auth: entry.password || entry.passwordEnv ? "password" : entry.privateKeyPath ? "key" : "none",
    disabled: !!entry.disabled, note: entry.note || null,
  }));
  return ok({ hosts, configError: config.configError || null, hostsPath: HOSTS_PATH, pooled: [...pool.keys()] });
});

server.registerTool("ssh_exec", {
  title: "执行远程命令",
  description: "在远程主机执行一条命令并返回 stdout/stderr/退出码。连接按主机复用。stdout 截断到 64KB、stderr 16KB（truncated 字段会标注）。host 用别名（hosts_list 查）或 user@host[:port]（仅密钥认证）。",
  inputSchema: { host: z.string().describe("主机别名或 user@host[:port]"), command: z.string().describe("要执行的命令"), timeout: z.number().int().min(1).max(600).optional().describe("秒，默认 60，上限 600") },
}, async ({ host, command, timeout }) => {
  try {
    const started = Date.now();
    const client = await getConnection(host);
    const result = await sshExec(client, command, (timeout || 60) * 1000);
    return ok({ host, ...result, durationMs: Date.now() - started });
  } catch (error) { return fail(error); }
});

server.registerTool("ssh_close", {
  title: "断开主机连接",
  description: "关闭到某主机的池化 SSH 连接（shell/隧道会话随之失效）。",
  inputSchema: { host: z.string() },
}, async ({ host }) => {
  const spec = resolveHost(host);
  const client = pool.get(spec.key);
  if (!client) return ok({ closed: false, note: "无池化连接" });
  client.end();
  pool.delete(spec.key);
  return ok({ closed: true });
});

server.registerTool("ssh_shell_open", {
  title: "打开交互 shell",
  description: "在远程主机打开持久交互式 shell（xterm 120x40），返回 sessionId。适合 REPL/长驻进程/需要环境状态的连续操作。",
  inputSchema: { host: z.string() },
}, async ({ host }) => {
  try {
    const client = await getConnection(host);
    const session = await openShell(client);
    return ok({ sessionId: session.id, host, openedAt: session.openedAt });
  } catch (error) { return fail(error); }
});

server.registerTool("ssh_shell_write", {
  title: "向 shell 写入并读回",
  description: "向已打开的 shell 会话写入输入，等待 waitMs 毫秒后返回期间到达的输出（≤32KB）。input 原样写入——需要回车自己带 \\n。",
  inputSchema: { sessionId: z.string(), input: z.string(), waitMs: z.number().int().min(50).max(5000).optional().describe("等待输出的毫秒数，默认 1000") },
}, async ({ sessionId, input, waitMs }) => {
  try { return ok(await shellWrite(sessionId, input, waitMs || 1000)); } catch (error) { return fail(error); }
});

server.registerTool("ssh_shell_close", {
  title: "关闭交互 shell",
  description: "关闭一个交互 shell 会话（SSH 连接保留在池里）。",
  inputSchema: { sessionId: z.string() },
}, async ({ sessionId }) => {
  const session = shells.get(sessionId);
  if (!session) return ok({ closed: false, note: "会话不存在" });
  session.stream.end();
  shells.delete(sessionId);
  return ok({ closed: true });
});

server.registerTool("sftp_ls", {
  title: "SFTP 列目录",
  description: "列出远程目录内容（名字/是否目录/大小/mtime）。",
  inputSchema: { host: z.string(), path: z.string().describe("远程目录路径") },
}, async ({ host, path }) => {
  try {
    const client = await getConnection(host);
    const sftp = await sftpOf(client);
    const entries = await sftpLs(sftp, path);
    return ok({ path, entries });
  } catch (error) { return fail(error); }
});

server.registerTool("sftp_get", {
  title: "SFTP 读文件",
  description: "读取远程文件内容（UTF-8 文本，默认最多 64KB，truncated 标注是否截断）。二进制文件不适合此工具。",
  inputSchema: { host: z.string(), path: z.string(), maxSize: z.number().int().min(1).max(1024 * 1024).optional().describe("最大读取字节数，默认 65536") },
}, async ({ host, path, maxSize }) => {
  try {
    const client = await getConnection(host);
    const sftp = await sftpOf(client);
    return ok(await sftpGet(sftp, path, maxSize || MAX_SFTP_GET));
  } catch (error) { return fail(error); }
});

server.registerTool("sftp_put", {
  title: "SFTP 写文件",
  description: "把文本内容写入远程文件（整体覆盖）。",
  inputSchema: { host: z.string(), path: z.string(), content: z.string() },
}, async ({ host, path, content }) => {
  try {
    const client = await getConnection(host);
    const sftp = await sftpOf(client);
    return ok(await sftpPut(sftp, path, content));
  } catch (error) { return fail(error); }
});

server.registerTool("ssh_tunnel_open", {
  title: "开本地隧道",
  description: "通过 SSH 主机建立本地端口转发：本地 127.0.0.1:localPort → 远端 remoteHost:remotePort。localPort 省略则自动分配。",
  inputSchema: { host: z.string(), remoteHost: z.string(), remotePort: z.number().int().min(1).max(65535), localPort: z.number().int().min(1).max(65535).optional() },
}, async ({ host, remoteHost, remotePort, localPort }) => {
  try {
    const client = await getConnection(host);
    const record = await openTunnel(client, remoteHost, remotePort, localPort || 0);
    return ok({ tunnelId: record.id, local: "127.0.0.1:" + record.localPort, remote: remoteHost + ":" + remotePort });
  } catch (error) { return fail(error); }
});

server.registerTool("ssh_tunnel_close", {
  title: "关本地隧道",
  description: "关闭一个本地转发隧道。",
  inputSchema: { tunnelId: z.string() },
}, async ({ tunnelId }) => {
  const record = tunnels.get(tunnelId);
  if (!record) return ok({ closed: false, note: "隧道不存在" });
  record.server.close();
  tunnels.delete(tunnelId);
  return ok({ closed: true });
});

// ---------- 启动 ----------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[dsh-ssh] MCP server ready on stdio; hosts:", HOSTS_PATH);
