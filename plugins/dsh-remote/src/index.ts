// @oh-summy/dsh-remote — M2+M3: quick tunnel + Caddy cookie gate + login page + notify + client page.
// Lean by design: node builtins + two host deps (zod, dsh-credentials). See docs/dsh-plugin-design.md.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// ---------- constants ----------

const RUN_DIR = join(homedir(), ".remote-control", "run-plugin");

const UPSTREAM_HOST = "127.0.0.1:3080"; // DSH web 的 authority（Host 头必须是裸 host:port，不能带 scheme）
const UPSTREAM = "http://" + UPSTREAM_HOST; // Caddy 的上游
const TUNNEL_ENTRY = "http://127.0.0.1:4080"; // cloudflared 的 --url 指向 Caddy 门（绝不直连 DSH）
const GATE_PORT = 4080;
const LOGIN_PORT = 9091;
const URL_TIMEOUT_MS = 45_000;
const RESPAWN_DELAY_MS = 5_000;
const LOGIN_LOCK_MS = 300_000;
const LOGIN_MAX_FAILS = 5;
const REVEAL_FREQ_MS = 60_000;
const BODY_LIMIT = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
// 登录页/管理 API 的合法 Host（防 DNS rebinding）：本机直连 9091、或经 4080 门进来（Caddy 保留原 Host）。
// 远端经 Caddy 转发的 Host 是隧道域名，走会话校验，不做 Host 检查。
const LOCAL_HOSTS = new Set([
  `127.0.0.1:${LOGIN_PORT}`, `localhost:${LOGIN_PORT}`, `[::1]:${LOGIN_PORT}`,
  `127.0.0.1:${GATE_PORT}`, `localhost:${GATE_PORT}`, `[::1]:${GATE_PORT}`,
]);
// CORS 白名单：只有本机 DSH 页面（3080）需要跨端口访问 4080 的 /rc-api；远端页面同源，不需要 CORS
const CORS_ORIGINS = new Set(["http://127.0.0.1:3080", "http://localhost:3080", "http://[::1]:3080"]);
const PASSWORD_REF = credentialRef("DSH_REMOTE_PASSWORD");
const SESSION_REF = credentialRef("DSH_REMOTE_SESSION_SECRET");
const WEBHOOK_REF = credentialRef("DSH_REMOTE_WEBHOOK_URL");
const APP_SECRET_REF = credentialRef("DSH_REMOTE_APP_SECRET");

export interface Config {
  enabled?: boolean;
  autoStart?: boolean;
  cloudflaredPath?: string;
  caddyPath?: string;
  autoRestart?: boolean;
  notifyChannel?: "off" | "group" | "dm";
  notifyAppId?: string;
  notifyOpenId?: string;
  notifyChatId?: string;
  notifyChatName?: string;
  sessionDays?: number;
  alias?: string;
}

// cordis 服务注入声明：凭据缝必须显式声明，否则 ctx.credentials 访问被拒
// ("cannot get property 'credentials' without inject"，M2 实测，事实 18)。
export const inject = ["credentials"];

// settings form（Plugins 页自动表单）。Config = zod（官方先例 dsh-plugin-market/dsh-agent-loop）。
// 运行时设置不再写 profile 用户层（写 = HMR 条目重启 = 9091 窗口 + 隧道换址）：
// 改存本插件自己的 settings.json，立即生效不重启；profile 只承载静态安装配置（路径类）。
export const Config = z.object({
  enabled: z.boolean().default(false).describe("启用远程访问（关闭即回收隧道；开启产生新的临时链接）"),
  autoStart: z.boolean().default(false).describe("跟随 DSH 启动：每次宿主启动时自动拉起隧道并经飞书推送新链接（关闭则只能手动启动）"),
  cloudflaredPath: z.string().default("").describe("cloudflared 路径（留空自动探测）"),
  caddyPath: z.string().default("").describe("caddy 路径（留空自动探测）"),
  // 兼容旧值（webhook/app 按传输方式）→ 新模型（group/dm 按收件人）：profile 遗留键不至于炸掉条目
  notifyChannel: z.preprocess((v) => (v === "webhook" || v === "app" ? "group" : v), z.enum(["off", "group", "dm"]).default("off")).describe("飞书通知：群聊或私聊"),
  notifyAppId: z.string().default("").describe("飞书 App ID（app 通道）"),
  notifyOpenId: z.string().default("").describe("私聊通知接收者 open_id（群通知不需要，页面可拉群列表自动选）"),
  notifyChatId: z.string().default("").describe("群通知 chat_id（页面「拉取群列表」自动填）"),
  notifyChatName: z.string().default("").describe("群通知显示名（随 chat_id 保存）"),
  autoRestart: z.boolean().default(true).describe("隧道进程意外退出时自动重拉（默认开）"),
  sessionDays: z.number().int().min(1).max(30).default(7).describe("远程会话有效天数（1-30，不可永久）"),
  alias: z.string().max(64).default("").describe("机器别名：飞书推送卡片与登录页显示的简称（留空只显示主机名 · IP）"),
});

// ---------- dsh-web 命令物化（issue #29：装插件即有命令；卸载后软链悬空自动失效） ----------

// 运行时真实路径：lib/index.mjs → ../bin/dsh-web.mjs（开发期 src/ 下同样成立），不写死仓库路径
function cliBinPath(): string {
  return fileURLToPath(new URL("../bin/dsh-web.mjs", import.meta.url));
}
const DSH_BIN_DIR = join(homedir(), ".dsh", "bin");
const CLI_LINK = join(DSH_BIN_DIR, "dsh-web"); // 第一级软链 → 插件已安装副本内的 bin
const NPM_BIN = join(homedir(), ".npm-global", "bin", "dsh-web"); // 第二级软链（PATH 已含 ~/.npm-global/bin）

function isSymlinkTo(p: string, target: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() && readlinkSync(p) === target;
  } catch { return false; }
}

// 只创建、绝不覆盖：路径不存在才建软链；已存在且指向精确自有目标 → ok；
// 悬空且目标含 ownStaleMarker（本插件旧安装残留：宿主被杀没跑 disposer 的合法悬空链）→ 接管重建；
// 其余（外来软链/普通文件/目录）→ 告警并跳过，绝不动用户文件。
function ensureLink(ctx: AnyCtx, linkPath: string, target: string, ownStaleMarker = ""): "created" | "ok" | "blocked" {
  let st = null;
  try { st = lstatSync(linkPath); } catch { /* absent */ }
  if (!st) { symlinkSync(target, linkPath); return "created"; }
  if (st.isSymbolicLink() && readlinkSync(linkPath) === target) return "ok";
  if (ownStaleMarker && st.isSymbolicLink()) {
    let stale = "";
    try { stale = String(readlinkSync(linkPath)); } catch { stale = ""; }
    if (stale.includes(ownStaleMarker) && !existsSync(stale)) {
      unlinkSync(linkPath);
      symlinkSync(target, linkPath);
      say(ctx, "info", `[dsh-remote] 接管旧安装残留的悬空链 ${linkPath}（原指向 ${stale}）`);
      return "created";
    }
  }
  let curDesc = "";
  try { curDesc = String(readlinkSync(linkPath)); } catch { curDesc = "（非软链）"; }
  say(ctx, "warn", `[dsh-remote] ${linkPath} 已存在且不指向本插件（${curDesc}）——不动用户文件，跳过`);
  return "blocked";
}
// 装载时物化：必须是软链，绝不拷贝。每次装载（含宿主重启、entry 重启）都确保链接存在。
// 设计决策（2026-11-21 实测拍板）：disposer **不删除**软链——
//   宿主每次正常关闭（stop/Ctrl-C）都会触发 disposer，无法与「插件卸载」区分；
//   曾按 spec 原文在 disposer 删除，导致 stop 后 dsh-web 命令自我删除、无法再启动（两次实测事故）。
//   生命周期改为：卸载 → 软链悬空 → 目标消失 → CLI 闸门报「插件未安装」并给安装指引
//   （issue #29 验收明确接受悬空软链）；停用 → 链接仍在但被闸门拦住（报「插件未打开」）。
export function materializeCli(ctx: AnyCtx): void {
  try {
    const bin = cliBinPath();
    if (!existsSync(bin)) { say(ctx, "warn", `[dsh-remote] CLI 缺失，跳过物化：${bin}`); return; }
    chmodSync(bin, 0o755);
    mkdirSync(DSH_BIN_DIR, { recursive: true });
    if (ensureLink(ctx, CLI_LINK, bin, "@oh-summy/dsh-remote") === "blocked") return; // 一级被外来占用 → 不再建二级，不报就绪
    try { mkdirSync(dirname(NPM_BIN), { recursive: true }); } catch { /* exists */ }
    const npmLink = ensureLink(ctx, NPM_BIN, CLI_LINK);
    if (npmLink === "ok" || npmLink === "created") {
      say(ctx, "info", "[dsh-remote] 命令已就绪：dsh-web（dsh-web help 看全部命令）");
    }
  } catch (e) {
    say(ctx, "warn", "[dsh-remote] dsh-web 命令物化失败：" + (e as Error).message);
  }
}
// ---------- small utils ----------

type AnyCtx = any;

function say(ctx: AnyCtx, method: "info" | "warn" | "error", msg: string) {
  const logger = ctx.logger;
  if (logger && typeof logger[method] === "function") logger[method](msg);
  else if (method === "info") console.log(msg);
  else console.error(msg);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findBinary(config: Config, name: "cloudflared" | "caddy"): string {
  const custom = name === "cloudflared" ? config.cloudflaredPath : config.caddyPath;
  const candidates = [custom, join(homedir(), ".remote-control", "bin", name)];
  for (const p of candidates) if (p && existsSync(p)) return p;
  return name;
}

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function htmlEsc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function readBody(req: http.IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return body;
}

// ---------- events (module-level：跨条目重启保留最近事件) ----------

const events: Array<{ time: string; type: string; detail: string }> = [];

function pushEvent(type: string, detail: string) {
  events.unshift({ time: new Date().toISOString().replace("T", " ").slice(0, 19), type, detail });
  if (events.length > 20) events.pop();
  try { writeFileSync(join(RUN_DIR, "events.json"), JSON.stringify(events, null, 2)); } catch { /* best effort */ }
}

// ---------- module state ----------

let cfg: Config = {};
let currentUrl = "";
let lastAnnouncedUrl = ""; // 已推送过的 URL（跨 spawn 去重，不随 spawn 重置）
let sessionSecret = ""; // 本插件会话 HMAC 密钥：签发/校验 rc_session 的带过期令牌（审查 #47）
let toggleBusy = false; // 启停串行化（审查 #48）：并发 toggle 立即 409，不叠 spawn
// ---------- 会话令牌：HMAC(exp) 签名 + 服务端过期校验（审查 #47） ----------
// 旧设计：rc_session = 静态 32-hex（服务端永久有效）。新设计：v1.<expB64url>.<hmac>，
// 服务端校验签名与 exp > now；泄露的令牌在 exp 后自动失效。重置密码轮换 sessionSecret → 旧令牌全部失效。
export function signSession(exp: number, secret: string): string {
  const payload = Buffer.from(String(exp)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `v1.${payload}.${sig}`;
}
export function verifySession(token: string, secret: string, now = Date.now()): boolean {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return false;
  const sig = crypto.createHmac("sha256", secret).update(m[1]).digest("base64url");
  if (!timingSafeEq(m[2], sig)) return false;
  const exp = Number(Buffer.from(m[1], "base64url").toString("utf8"));
  return Number.isFinite(exp) && exp > now;
}
let dshSessionSecret = ""; // DSH 的 browser-session secret（签 dsh-auth-* cookie，读自凭据缝文件）
let password = "";
let caddyChild: ChildProcess | null = null;
let cloudflaredChild: ChildProcess | null = null;
let loginServer: http.Server | null = null;
let urlTimer: NodeJS.Timeout | null = null;
let stopping = false; // 命令式停止中：子进程 exit 回调不得当作崩溃重拉
let fiberAlive: (() => boolean) | null = null; // 当前 fiber 的生命旗标（spawn 系函数经它判定是否续命）
const timers = new Set<NodeJS.Timeout>(); // respawn 定时器登记：disposer 统一清理（第 2 轮自审 P0-1）
const failCounts = new Map<string, { count: number; until: number }>();
const revealAt = new Map<string, number>();

function notifyText(): string {
  return password; // 换址通知必带完整密码（自救需要，用户拍板不做档位）
}

// ---------- notify ----------

// 卡片结构为「复制友好」设计：标签行 / 内容行各自独立 div 区块，区块间天然留白；
// "---" 渲染为分隔线。链接在正文里本身可点可复制，不再放「打开 DSH」按钮（主人拍板：冗余）。
const MARKET_URL = "https://github.com/oh-summy/dsh-nano-market";

// ---------- 机器身份（别名 + 主机名 + 内网 IP） ----------
// 多台机器都开远程访问时，推送/登录页据此区分是哪一台。
// IP 取第一个非内部 IPv4（内网地址；公网出口 IP 会随网络变，不取）。
function primaryLanIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "";
}
const MACHINE_HOST = hostname();
const MACHINE_IP = primaryLanIp();
// 展示层 IP 掩码：只留前两段（足以区分机器，不暴露完整内网地址）。
export function maskIp(ip: string): string {
  const parts = ip.split(".");
  return parts.length === 4 ? parts.slice(0, 2).join(".") + ".***.***" : ip;
}
// 纯格式化（可测）：别名 · 主机名 · IP掩码——卡片标题/登录页/state/CLI 的唯一机器行实现。
export function formatMachineLine(alias: string | undefined, host: string, ip: string): string {
  return [alias?.trim(), host, ip ? maskIp(ip) : ""].filter(Boolean).join(" · ");
}
// 别名在配置表单（alias）填写；留空则机器行只显示主机名 · IP（掩码后）。
function machineLine(alias?: string): string {
  return formatMachineLine(alias, MACHINE_HOST, MACHINE_IP);
}

function cardFor(title: string, color: string, lines: string[], note: string) {
  const elements: any[] = [];
  for (const line of lines) {
    if (line === "---") elements.push({ tag: "hr" });
    else elements.push({ tag: "div", text: { tag: "lark_md", content: line } });
  }
  elements.push({ tag: "action", actions: [
    { tag: "button", text: { tag: "plain_text", content: "dsh-nano-market" }, url: MARKET_URL, type: "default" },
  ] });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: note }] });
  return { header: { title: { tag: "plain_text", content: title }, template: color }, elements };
}

async function sendWebhook(card: any): Promise<void> {
  const hook = await getSecret(WEBHOOK_REF);
  if (!hook) throw new Error("还没有填 webhook 地址——在下方通知设置里粘贴");
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("webhook HTTP " + res.status);
}

async function getTenantToken(): Promise<string> {
  const appId = cfg.notifyAppId || "";
  const appSecret = await getSecret(APP_SECRET_REF);
  if (!appId || !appSecret) throw new Error("App ID / App Secret 未配置（先在通知设置里填好）");
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const tokenJson = await tokenRes.json() as any;
  if (!tokenJson.tenant_access_token) throw new Error("凭据无效或权限缺失：" + (tokenJson.msg || "unknown"));
  return tokenJson.tenant_access_token as string;
}

async function sendApp(card: any): Promise<void> {
  // 群通知（chat_id）优先——页面「拉取群列表」自动选；私聊按前缀识别 on_=union_id / ou_=open_id
  //（union_id 跨同开发商应用通用：从别的应用查到的身份也能直接用，绕开本应用无通讯录权限的限制）
  const receiveId = cfg.notifyChatId || cfg.notifyOpenId;
  if (!receiveId) throw new Error("接收者未配置：点「拉取群列表」选群，或填私聊 open_id / union_id");
  const receiveIdType = cfg.notifyChatId ? "chat_id" : String(receiveId).startsWith("on_") ? "union_id" : "open_id";
  const token = await getTenantToken();
  const sendRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ receive_id: receiveId, msg_type: "interactive", content: JSON.stringify(card) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const sendJson = await sendRes.json() as any;
  if (sendJson.code !== 0) throw new Error("发送失败 code " + sendJson.code + "：" + (sendJson.msg || "unknown") + "（常见原因：应用缺 im:message 发消息权限）");
}

async function sendNotify(ctx: AnyCtx, event: string, url: string | null): Promise<{ ok: boolean; error?: string }> {
  const channel = cfg.notifyChannel || "off";
  if (channel === "off") return { ok: false, error: "通知未开启" };
  const meta: Record<string, [string, string]> = {
    started: ["远程访问已开启", "green"], changed: ["访问地址已变化", "blue"],
    down: ["远程访问已断开", "red"], recovered: ["远程访问已恢复", "green"], test: ["测试通知", "grey"],
    enabled: ["通知已开启", "green"],
  };
  const [baseTitle, color] = meta[event] ?? ["远程访问", "grey"];
  // 机器身份进标题（负责人 2026-11-23 定版）：推送标题即带 别名 · 主机名 · IP 前两段。
  const title = baseTitle + " · " + machineLine(cfg.alias);
  const tier = notifyText(); // 换址必带完整密码：能自救（用户拍板，不做档位）
  // 独立区块 + 分隔线：机器身份在标题（卡片头一行即可分辨机器），地址和密码各自前后留白。
  let lines: string[];
  if (event === "down" || event === "recovered") {
    lines = url ? ["**最新地址**", url] : ["隧道进程已退出，正在自动恢复。"];

  } else {
    lines = url ? ["**访问地址**", url, "---", "**访问密码**", tier] : ["（隧道未运行，暂无访问地址）", "**访问密码**", tier];
  }
  const card = cardFor(title, color, lines, "dsh-remote · by @oh-summy · " + new Date().toLocaleString("zh-CN"));
  try {
    if (channel === "group") {
      // 群聊两种发法：优先应用身份（拉过群列表），否则群机器人 webhook
      const hook = await getSecret(WEBHOOK_REF);
      if (cfg.notifyChatId) await sendApp(card);
      else if (hook) await sendWebhook(card);
      else throw new Error("群聊未配置：点「拉取群列表」选群（走应用），或填群机器人 webhook 地址");
    } else {
      if (!cfg.notifyOpenId) throw new Error("私聊需要 open_id（开放平台消息日志里可查）");
      await sendApp(card);
    }
    pushEvent(event, "通知已发送");
    return { ok: true };
  } catch (e) {
    const m = (e as Error).message;
    pushEvent(event, "通知失败：" + m);
    say(ctx, "warn", `[dsh-remote] notify failed: ${m}`);
    return { ok: false, error: m };
  }
}

// ---------- secrets (dsh-credentials seam, fallback local 0600 file) ----------

function fallbackSecrets(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(RUN_DIR, "secrets.json"), "utf8")); }
  catch { return {}; }
}

// 凭据缝 resolve 可能在宿主启动早期挂起（2026-11-21 launchd boot 实测）：
// 管理面接口一律带超时兜底——宁可短暂显示「未配置」，也不能把接口挂死（CLI 轮询/页面都会卡）。
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
async function getSecret(ref: string): Promise<string | null> {
  const ctx = (globalThis as any).__dshRemoteCtx;
  if (ctx?.credentials) {
    const hit = await ctx.credentials.resolve(ref);
    return hit?.value ?? null;
  }
  return fallbackSecrets()[ref] ?? null;
}

async function setSecret(ctx: AnyCtx, ref: string, value: string): Promise<void> {
  if (ctx.credentials) { await ctx.credentials.set(ref, value); return; }
  const all = fallbackSecrets();
  all[ref] = value;
  writeFileSync(join(RUN_DIR, "secrets.json"), JSON.stringify(all, null, 2), { mode: 0o600 });
  try { chmodSync(join(RUN_DIR, "secrets.json"), 0o600); } catch { /* just created with mode */ }
}

async function ensureSecrets(ctx: AnyCtx): Promise<void> {
  // DSH 的 browser-session secret：签 dsh-auth-* cookie 用（读凭据缝文件，Q1 spike 已验证全链路）
  try {
    const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const m = yaml.match(/client-connection\/browser-session:[\s\S]{0,500}?secret:\s*["']?([A-Za-z0-9_+/=-]+)/);
    if (m) dshSessionSecret = m[1];
    else say(ctx, "warn", "[dsh-remote] 未找到 DSH browser-session secret——远程登录后将只发 rc_session，用户需自行通过 DSH fence");
  } catch {
    say(ctx, "warn", "[dsh-remote] 读取 .credentials.yaml 失败——同上");
  }
  password = (await getSecret(PASSWORD_REF)) ?? "";
  if (!password) { password = hex(16); await setSecret(ctx, PASSWORD_REF, password); pushEvent("init", "访问密码已生成"); }
  sessionSecret = (await getSecret(SESSION_REF)) ?? "";
  if (!sessionSecret) { sessionSecret = hex(32); await setSecret(ctx, SESSION_REF, sessionSecret); }
}

// ---------- DSH signed cookie (port of auth-server.py, fact 16) ----------

function dshCookieParts(authority: string): { name: string; value: string } | null {
  if (!dshSessionSecret) return null; // 无 DSH secret 时只发 rc_session（fence 需用户另行通过）
  const b64url = (buf: Buffer) => buf.toString("base64url");
  const name = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());
  const secretBytes = Buffer.from(dshSessionSecret, "base64url");
  const now = Date.now();
  const days = Math.min(Math.max(Number(cfg.sessionDays) || 7, 1), 30);
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + days * 86400 * 1000 })));
  const sig = b64url(crypto.createHmac("sha256", secretBytes).update(body).digest());
  return { name, value: "v1." + body + "." + sig };
}

// ---------- login page + management API (127.0.0.1:9091) ----------

function classify(req: http.IncomingMessage): { isLocal: boolean; ip: string } {
  const cfIp = String(req.headers["cf-connecting-ip"] || "");
  const xff = String(req.headers["x-forwarded-for"] || "");
  const socketAddr = String(req.socket.remoteAddress || "");
  // 本机豁免收紧（审查三轮 P1-3 fail-open → fail-closed）：仅限 socket 精确 loopback
  // 且完全无代理头。经 Caddy 的请求恒带 x-forwarded-for（Caddy 自己追加）→ 一律按远端处理。
  const isLocal = !cfIp && !xff && (socketAddr === "127.0.0.1" || socketAddr === "::1");
  return { isLocal, ip: cfIp || xff || socketAddr };
}

function startLoginServer(ctx: AnyCtx): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const origin = String(req.headers.origin || "");
      const { isLocal, ip } = classify(req);
      // DNS rebinding 防护：本机直连的请求 Host 必须是 9091 的合法形态
      if (isLocal && !LOCAL_HOSTS.has(String(req.headers.host || ""))) { res.writeHead(403); res.end(); return; }
      // CORS 白名单：本机 DSH 页面（3080）跨端口走 CORS；远端页面与隧道域同源（Origin == 自身 Host），
      // 浏览器表单/fetch 自带的这个 Origin 必须放行——否则远程登录 POST 一律 403（用户实撞的 bug）。
      // 恶意网站跨站写的 Origin ≠ 本站 Host，仍然 403（防 drive-by）。
      const host0 = String(req.headers.host || "");
      const selfOrigin = origin === "https://" + host0 || origin === "http://" + host0;
      if (origin && !selfOrigin) {
        if (CORS_ORIGINS.has(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Credentials", "true");
          res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        } else if (req.method !== "GET") { res.writeHead(403); res.end(); return; }
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/rc-login") {
        const lock = failCounts.get(ip);
        const lockLeft = lock && lock.count >= LOGIN_MAX_FAILS ? Math.ceil((lock.until - Date.now()) / 1000) : 0;
        const tunnelHost = String(req.headers.host || "").replace(/:\d+$/, "");
        const lockMsg = lockLeft > 0
          ? `<div class="chip err">尝试次数过多，${lockLeft}s 后可重试</div>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程访问</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(165deg, #0b1220 0%, #16233b 55%, #1b2c49 100%); color: #e6edf7;
    font-family: system-ui,-apple-system,sans-serif; padding: 24px; }
  .card { width: 100%; max-width: 380px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.09);
    border-radius: 16px; padding: 30px 28px 24px; backdrop-filter: blur(8px); }
  .mark { font-size: 12px; letter-spacing: .14em; color: #8aa0bf; text-transform: uppercase; }
  h1 { font-size: 21px; margin: 10px 0 4px; font-weight: 650; }
  .sub { color: #8aa0bf; font-size: 13px; margin: 0 0 20px; line-height: 1.6; }
  .host { display: inline-block; font-family: ui-monospace,monospace; font-size: 11.5px; color: #9fd0a8;
    background: rgba(157,208,168,.09); border: 1px solid rgba(157,208,168,.25); border-radius: 999px;
    padding: 3px 10px; margin-bottom: 18px; word-break: break-all; }
  .tunnel { display: flex; align-items: center; gap: 8px; margin: 0 0 20px; color: #5b7292; font-size: 11px; }
  .tunnel .line { flex: 1; height: 1px; background: linear-gradient(90deg, rgba(143,163,191,.55), rgba(143,163,191,.15)); position: relative; }
  .tunnel .line i { position: absolute; top: -2.5px; width: 6px; height: 6px; border-radius: 99px; background: #4f8cff; }
  .tunnel .line i.a { left: 0; } .tunnel .line i.b { right: 0; animation: pulse 2.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  @media (prefers-reduced-motion: reduce) { .tunnel .line i.b { animation: none } }
  input[type=password] { width: 100%; padding: 13px 14px; font-size: 16px; background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.14); border-radius: 10px; color: #e6edf7; outline: none; }
  input[type=password]:focus { border-color: #4f8cff; box-shadow: 0 0 0 3px rgba(79,140,255,.22); }
  button { width: 100%; padding: 13px; margin-top: 14px; font-size: 15px; font-weight: 600; cursor: pointer;
    background: #4f8cff; border: none; border-radius: 10px; color: #fff; }
  button:focus-visible, input:focus-visible { outline: 2px solid #9cc2ff; outline-offset: 2px; }
  .chip { border-radius: 10px; padding: 10px 12px; font-size: 13px; margin: 0 0 14px; line-height: 1.5; }
  .chip.err { background: rgba(220,38,38,.12); border: 1px solid rgba(220,38,38,.35); color: #fca5a5; }
  .foot { color: #5b7292; font-size: 12px; margin: 18px 0 0; line-height: 1.6; }
  .machine{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:.02em;color:#9fb6d9;margin:-6px 0 14px}
</style></head>
<body><div class="card">
  <div class="mark">deepseek harness · 远程访问</div>
  <h1>本机 DSH 的安全门</h1>
  <p class="machine">${htmlEsc(machineLine(cfg.alias))}</p>
  <p class="sub">输入访问密码即可使用这台机器上的 DSH。会话 7 天内有效。</p>
  <span class="host">${htmlEsc(tunnelHost)}</span>
  <div class="tunnel"><span>你</span><span class="line"><i class="a"></i><i class="b"></i></span><span>Cloudflare</span><span class="line"><i class="a"></i><i class="b"></i></span><span>本机 DSH</span></div>
  ${lockMsg}
  <form method="post" action="/rc-login">
    <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="current-password" required>
    <button type="submit">进入 DSH</button>
  </form>
  <p class="foot">密码由本机 DSH 的「远程访问」插件生成，可在插件页面查看或重置。连续失败 5 次将锁定 5 分钟。</p>
</div></body></html>`);
        return;
      }

      if (req.method === "POST" && path === "/rc-login") {
        const lock = failCounts.get(ip);
        if (lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now()) { res.writeHead(429); res.end("locked"); return; }
        const supplied = String(new URLSearchParams(await readBody(req)).get("password") || "");
        if (timingSafeEq(supplied, password)) {
          failCounts.delete(ip);
          // rc_session = 带过期时间的签名令牌：服务端校验签名与 exp（审查 #47）
          const dsh = dshCookieParts(UPSTREAM_HOST);
          const days = Math.min(Math.max(Number(cfg.sessionDays) || 7, 1), 30);
          // Secure：入口恒为 https 隧道；本机管理走 127.0.0.1:9091 直连 API，不依赖该 Cookie（审查二轮 P2-1）
          const cookies = [`rc_session=${signSession(Date.now() + days * 86400000, sessionSecret)}; HttpOnly; Path=/; Max-Age=${days * 86400}; SameSite=Strict; Secure`];
          if (dsh) cookies.push(`${dsh.name}=${dsh.value}; HttpOnly; Path=/; Max-Age=${days * 86400}; SameSite=Lax`);
          res.writeHead(302, { Location: "/", "Set-Cookie": cookies });
          res.end();
          return;
        }
        const count = (lock?.count ?? 0) + 1;
        failCounts.set(ip, { count, until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0 });
        if (failCounts.size > 200) for (const [k, v] of failCounts) if (v.until < Date.now()) failCounts.delete(k); // 防慢泄漏
        pushEvent("auth", "登录失败（" + (count >= LOGIN_MAX_FAILS ? "已锁 5 分钟" : count + "/5") + "）");
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<meta charset='utf-8'>密码错误，<a href='/rc-login'>重试</a>");
        return;
      }

      // /rc-auth — Caddy forward_auth 的校验端点：只认有效签名会话，无任何豁免（审查三轮 P1-1/P1-3）。
      if (req.method === "GET" && path === "/rc-auth") {
        const cv = /rc_session=([^;]+)/.exec(String(req.headers.cookie || ""))?.[1] ?? "";
        const ok = Boolean(cv) && verifySession(cv, sessionSecret);
        res.writeHead(ok ? 200 : 401, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(ok ? "ok" : "unauthorized");
        return;
      }

      // /rc-api/* — 本机直连（loopback 且无代理头）或持有门令牌的会话
      if (path.startsWith("/rc-api/")) {
        const cookieValue = /rc_session=([^;]+)/.exec(String(req.headers.cookie || ""))?.[1] ?? "";
        const authed = isLocal || (cookieValue && verifySession(cookieValue, sessionSecret));
        if (!authed) { res.writeHead(401); res.end("unauthorized"); return; }

        if (req.method === "GET" && path === "/rc-api/state") {
          const appSecret = await withTimeout(getSecret(APP_SECRET_REF), 2500, null);
          // 掩码只到前几位：页面能看出"已配置"，但完整身份串不出管理面
          const mask = (v: unknown, n: number) => (v ? String(v).slice(0, n) + "••••••" : "");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            running: !!cloudflaredChild?.pid && pidAlive(cloudflaredChild.pid),
            url: currentUrl,
            passwordMask: password.slice(0, 4) + "••••••••",
            autoStart: cfg.autoStart === true,
            autoRestart: cfg.autoRestart !== false,
            sessionDays: Number(cfg.sessionDays) || 7,
            channel: cfg.notifyChannel || "off",
            alias: cfg.alias || "",
            machineHost: MACHINE_HOST,
            machineIp: MACHINE_IP,
            machineLine: machineLine(cfg.alias),
            hasWebhook: !!(await withTimeout(getSecret(WEBHOOK_REF), 2500, null)),
            hasAppSecret: !!appSecret,
            appIdMask: mask(cfg.notifyAppId, 6),
            openIdMask: mask(cfg.notifyOpenId, 6),
            appSecretMask: mask(appSecret, 4),
            chatId: cfg.notifyChatId || "",
            chatName: cfg.notifyChatName || "",
            events,
          }));
          return;
        }
        if (req.method === "GET" && path === "/rc-api/appcheck") {
          // 配置体检：token 有效性 + im:message（发消息，私聊/群聊都要）+ im:chat（拉群列表，群聊要）。
          // im:message 用全零 receive_id 探测：有权限 → 返回「receive_id 无效」类业务错误；无权限 → 权限错误码。不实际投递。
          const out: Record<string, unknown> = { token: false, imMessage: null, imChat: null, error: "" };
          try {
            const token = await getTenantToken();
            out.token = true;
            try {
              const r = await fetch("https://open.feishu.cn/open-apis/im/v1/chats?page_size=1", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
              out.imChat = ((await r.json()) as any).code === 0;
            } catch { /* 网络问题保持 null */ }
            try {
              const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
                body: JSON.stringify({ receive_id: "ou_0000000000000000000000000000", msg_type: "text", content: "{\"text\":\"x\"}" }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
              });
              const j = (await r.json()) as any;
              const denied = j.code === 99991672 || j.code === 99991661 || /scope|权限/.test(String(j.msg || ""));
              out.imMessage = !denied;
            } catch { /* 保持 null */ }
          } catch (e) { out.error = (e as Error).message; }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/reveal") {
          // 限频只对远端有意义（已登录的共享设备）；本机页面（3080→9091）是主人自己，豁免——
          // 否则自动化测试/连续操作会吃掉主人的配额，眼睛和复制全部误报「操作过于频繁」
          const last = revealAt.get(ip) ?? 0;
          if (!isLocal && Date.now() - last < REVEAL_FREQ_MS) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "操作过于频繁，60s 一次" })); return; }
          // 淘汰过期项：本 Map 只服务 60s 限频，过期即无意义——
          // 不清理会随远端 IP（cf-connecting-ip）轮换无界慢涨。
          const now = Date.now();
          for (const [k, v] of revealAt) if (now - v >= REVEAL_FREQ_MS) revealAt.delete(k);
          revealAt.set(ip, now);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ password }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/reset") {
          password = hex(16);
          await setSecret(ctx, PASSWORD_REF, password);
          sessionSecret = hex(32);
          await setSecret(ctx, SESSION_REF, sessionSecret);
          // RC_TOKEN 已移出 Caddyfile：重置无需重启 Caddy（审查三轮 P1-4 更优修复）。
          // 旧 rc_session 因 sessionSecret 轮换全部失效；dsh-auth 单独放行路径已删除 → 远程访问彻底失效。
          pushEvent("password", "密码已重置（所有远程会话已失效；请用新密码重新通过门禁）");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/notify-secret") {
          const json = JSON.parse(await readBody(req) || "{}") as any;
          if (json.webhookUrl) await setSecret(ctx, WEBHOOK_REF, String(json.webhookUrl));
          if (json.appSecret) await setSecret(ctx, APP_SECRET_REF, String(json.appSecret));
          pushEvent("notify", "通知凭据已更新");
          // 凭据补齐使配置变完整的瞬间：立即推一条带链接+密码的通知（App Secret 常常是最后一块拼图）
          if (currentUrl) {
            const ch = cfg.notifyChannel || "off";
            const ready = ch === "dm" ? !!cfg.notifyOpenId
              : ch === "group" ? (!!cfg.notifyChatId || !!(await getSecret(WEBHOOK_REF)))
              : false;
            if (ready) void sendNotify(ctx, "enabled", currentUrl);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/toggle") {
          // 命令式启停：不写 profile（写 = HMR 条目重启 = 9091 窗口 + 无谓换链接）。
          // 管理面全程在线；stopped 时子进程 exit 回调按 stopping 旗标跳过重拉。
          // 串行化（审查 #48）：并发 toggle 立即 409，不叠 spawn。
          if (toggleBusy) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "启停操作进行中，请稍候" })); return; }
          toggleBusy = true;
          try {
            const target = !cfg.enabled;
            if (target) await startTunnel(ctx);
            else stopTunnel(ctx);
            if (target && (!cloudflaredChild?.pid || !pidAlive(cloudflaredChild.pid))) throw new Error("隧道启动后进程退出——请查看 cloudflared 日志"); // await 后重查（审查 #48）
            cfg = { ...cfg, enabled: target } as Config;
            if (!saveSettings()) throw new Error("settings persist failed"); // 进程已实际切换：cfg 与之对齐，仅上报持久化失败
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, enabled: target }));
          } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (e as Error).message }));
          } finally {
            toggleBusy = false;
          }
          return;
        }
        if (req.method === "GET" && path === "/rc-api/chats") {
          // 拉取机器人所在群列表（im/v1/chats）：「通知到群」可自动选择，绕开 open_id 不可自动获取的限制
          try {
            const token = await getTenantToken();
            const chatsRes = await fetch("https://open.feishu.cn/open-apis/im/v1/chats?page_size=50", {
              headers: { Authorization: "Bearer " + token },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            const chatsJson = await chatsRes.json() as any;
            if (chatsJson.code !== 0) throw new Error("拉取失败 code " + chatsJson.code + "：" + (chatsJson.msg || "") + "（应用需要 im:chat 群组权限，且机器人要已被拉进群）");
            const chats = (chatsJson.data?.items || []).map((c: any) => ({ chatId: c.chat_id, name: c.name }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ chats }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
          return;
        }
        if (req.method === "POST" && path === "/rc-api/config") {
          // 页面设置：存本插件 settings.json + 内存即时生效——不写 profile、不重启条目、不换链接
          const json = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
          const fields: Record<string, unknown> = {};
          if (json.notifyChannel !== undefined) {
            const ch = String(json.notifyChannel);
            if (!["off", "group", "dm"].includes(ch)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "通道取值非法" })); return; }
            fields.notifyChannel = ch;
          }
          if (json.notifyAppId !== undefined) fields.notifyAppId = String(json.notifyAppId);
          if (json.notifyOpenId !== undefined) fields.notifyOpenId = String(json.notifyOpenId);
          if (json.notifyChatId !== undefined) fields.notifyChatId = String(json.notifyChatId);
          if (json.notifyChatName !== undefined) fields.notifyChatName = String(json.notifyChatName);
          if (json.autoRestart !== undefined) fields.autoRestart = !!json.autoRestart;
          if (json.autoStart !== undefined) fields.autoStart = !!json.autoStart;
          if (json.alias !== undefined) {
            const rawAlias = typeof json.alias === "string" ? json.alias : "";
            fields.alias = Array.from(rawAlias.replace(/[\u0000-\u001f\u007f]/g, "").trim()).slice(0, 64).join("");
          }
          if (json.sessionDays !== undefined) fields.sessionDays = Math.min(Math.max(parseInt(String(json.sessionDays), 10) || 7, 1), 30);
          const prevCfg = cfg;
          cfg = { ...cfg, ...fields } as Config;
          if (!saveSettings()) {
            cfg = prevCfg; // 持久化失败：回滚内存态，不谎报成功、不发通知（审查二轮 P1）
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "settings persist failed" }));
            return;
          }
          pushEvent("config", "设置已保存（立即生效）");
          // 通知配置一旦齐备：立即推一条带链接+密码的消息（闭环确认 + 把当前入口送达）
          const becameReady =
            (fields.notifyChannel && fields.notifyChannel !== "off") ||
            fields.notifyChatId ||
            fields.notifyOpenId;
          if (becameReady && (cfg.notifyChannel || "off") !== "off" && currentUrl) void sendNotify(ctx, "enabled", currentUrl);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && path === "/rc-api/envcheck") {
          const out: Record<string, unknown> = {};
          for (const name of ["cloudflared", "caddy"] as const) {
            const p = findBinary(cfg, name);
            const absolute = p !== name;
            let found = absolute && existsSync(p);
            let version = "";
            if (found) {
              const r = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 4000 });
              version = (r.stdout || "").split("\n")[0].slice(0, 60);
            } else {
              const w = spawnSync("which", [name], { encoding: "utf8" });
              found = w.status === 0;
            }
            out[name] = { found, path: p, version };
          }
          out.dshSecret = !!dshSessionSecret;
          out.cfAccount = true; // quick tunnel 免账号：无需任何 Cloudflare 配置（固定域名才需要账号，暂不支持）
          // 隧道链路自检：运行中时从公网侧把当前链接拉一遍，登录页可达 = 全链路通
          if (currentUrl) {
            try {
              const r = await fetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(8000) });
              out.tunnelLink = { ok: r.status > 0 && r.status < 500, status: r.status };
            } catch (e) { out.tunnelLink = { ok: false, status: String((e as Error).message).slice(0, 60) }; }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/test") {
          const channel = cfg.notifyChannel || "off";
          if (channel === "off") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "通知未开启" })); return; }
          const r = await sendNotify(ctx, "test", currentUrl || null);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r && r.ok ? { ok: true, detail: "测试消息已发送，请看飞书" } : { ok: false, error: r && r.error }));
          return;
        }
      }

      res.writeHead(404); res.end();
    } catch (e) {
      say(ctx, "error", "[dsh-remote] api error: " + (e as Error).message);
      try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); } catch { /* headed */ }
    }
  });
  return server;
}

// ---------- process management ----------

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

function waitPortFree(port: number, tries = 10): Promise<boolean> {
  return new Promise((resolve) => {
    const tick = (left: number) => {
      portBusy(port).then((busy) => {
        if (!busy) return resolve(true);
        if (left <= 0) return resolve(false);
        setTimeout(() => tick(left - 1), 300);
      });
    };
    tick(tries);
  });
}

function procName(pid: number): string {
  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return (out.stdout || "").trim().split("/").pop() || "";
  } catch { return ""; }
}

function readPid(name: string): number {
  try { return Number(readFileSync(join(RUN_DIR, name + ".pid"), "utf8").trim()); } catch { return 0; }
}

// 运行时设置存本插件自己的文件（RUN_DIR/settings.json）：写 profile 用户层会触发
// HMR 条目重启（9091 窗口 + 隧道无谓换址），改自己的文件则立即生效零扰动。
// profile patch 只承载静态安装配置；首次启动把旧 profile 块的值一次性迁移进来。
const PROFILE_PATCH = join(homedir(), ".dsh", "profiles", "web", "cordis.patch.yml");
const SETTINGS_FILE = join(RUN_DIR, "settings.json");

function readUserBlock(): { lines: string[]; start: number; end: number; text: string } | null {
  try {
    const s = readFileSync(PROFILE_PATCH, "utf8");
    const lines = s.split("\n");
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "- id: dsh-remote") { start = i; break; }
    }
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^- /.test(lines[i])) { end = i; break; }
    }
    return { lines, start, end, text: lines.slice(start, end).join("\n") };
  } catch { return null; }
}

function blockValue(blockText: string, key: string): string | null {
  const m = new RegExp("^\\s+" + key + ":\\s*(.+)$", "m").exec(blockText);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function loadSettings(): Config {
  const migrateChannel = (c: unknown): string => {
    // 旧模型（webhook/app 按传输方式）→ 新模型（group/dm 按收件人）
    if (c === "webhook") return "group";
    if (c === "app") return "group";
    if (c === "dm" || c === "group" || c === "off") return c;
    return "off";
  };
  const raw: Record<string, unknown> = (() => {
    // 三段分离（审查三轮 P1-2）：read（ENOENT=首次启动迁移；其他 I/O 向上抛）
    // → parse（JSON 损坏=留档）→ schema（非对象=留档）；留档失败即停，不继续迁移/写盘。
    let text: string;
    try { text = readFileSync(SETTINGS_FILE, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // 首次启动：profile 用户层的运行时键一次性搬进 settings.json
        const cur = readUserBlock();
        const migrated: Record<string, unknown> = {};
        if (cur) {
          for (const k of ["enabled", "autoRestart", "notifyChannel", "notifyAppId", "notifyOpenId", "sessionDays"] as const) {
            const v = blockValue(cur.text, k);
            if (v !== null) migrated[k] = v === "true" ? true : v === "false" ? false : (k === "sessionDays" ? Number(v) : v);
          }
        }
        return migrated;
      }
      throw error; // EACCES/EIO 等：明确上抛，由插件装载层上报，绝不按首次启动清盘
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { parsed = undefined; } // JSON 损坏 → 走留档
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // 非对象/null 也是损坏：留档（含 JSON.parse 失败的原文——重命名保留的是原文件本身）
      renameSync(SETTINGS_FILE, SETTINGS_FILE + ".corrupt-" + Date.now());
      const dir = dirname(SETTINGS_FILE);
      const olds = readdirSync(dir).filter((f: string) => f.startsWith("settings.json.corrupt-")).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 5))) rmSync(join(dir, f), { force: true });
      // 首次启动迁移同上（用户层的运行时键仍在）
      const cur = readUserBlock();
      const migrated: Record<string, unknown> = {};
      if (cur) {
        for (const k of ["enabled", "autoRestart", "notifyChannel", "notifyAppId", "notifyOpenId", "sessionDays"] as const) {
          const v = blockValue(cur.text, k);
          if (v !== null) migrated[k] = v === "true" ? true : v === "false" ? false : (k === "sessionDays" ? Number(v) : v);
        }
      }
      return migrated;
    }
    return parsed as Record<string, unknown>;
  })();
  const s = raw as Config;
  s.notifyChannel = migrateChannel(s.notifyChannel) as Config["notifyChannel"];
  // autoStart 未设置的老用户：沿用旧行为（enabled=true 本来就是「每次启动自动拉起」）
  if (s.autoStart === undefined) s.autoStart = s.enabled === true;
  if (!s.notifyChatId && s.notifyChannel === "group" && s.notifyOpenId) {
    // app+open_id 且没选过群 → 语义上更像私聊
    s.notifyChannel = "dm";
  }
  return s;
}

// 原子写（审查 P1-5）：临时文件 + rename，崩溃不留半文件；失败返回 false 由调用方上报。
function saveSettings(): boolean {
  const s = {
    enabled: cfg.enabled === true,
    autoStart: cfg.autoStart === true,
    autoRestart: cfg.autoRestart !== false,
    notifyChannel: cfg.notifyChannel || "off",
    notifyAppId: cfg.notifyAppId || "",
    notifyOpenId: cfg.notifyOpenId || "",
    notifyChatId: cfg.notifyChatId || "",
    notifyChatName: cfg.notifyChatName || "",
    sessionDays: Number(cfg.sessionDays) || 7,
    alias: cfg.alias || "",
  };
  const tmp = SETTINGS_FILE + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, SETTINGS_FILE);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
    return false;
  }
}

async function reapOrphans(ctx: AnyCtx): Promise<void> {
  for (const name of ["caddy", "cloudflared"]) {
    const pid = readPid(name);
    if (pid > 0 && pidAlive(pid)) {
      if (procName(pid) !== name) continue; // PID 复用给了别的程序——绝不误杀
      try { process.kill(pid); say(ctx, "info", `[dsh-remote] reaped orphan ${name} (pid ${pid})`); } catch { /* gone */ }
      rmSync(join(RUN_DIR, name + ".pid"));
    }
  }
  if (!(await waitPortFree(GATE_PORT))) {
    throw new Error(`端口 ${GATE_PORT} 被非本插件进程占用（可能 v0.3.x 网关在跑：先 dsh-web stop）— fail loud，不抢端口`);
  }
  // 9091 是本插件专属：启动期上一代 fiber 释放有延迟，等待即可（listen 自带重试）
  await waitPortFree(LOGIN_PORT);
}

function spawnCaddy(ctx: AnyCtx): void {
  const alive = () => fiberAlive?.() ?? false;
  const caddyfile = join(RUN_DIR, "Caddyfile");
  writeFileSync(caddyfile, renderCaddyfile());
  caddyChild = spawn(findBinary(cfg, "caddy"), ["run", "--config", caddyfile], {
    cwd: RUN_DIR,
    env: { ...process.env, RC_UPSTREAM: UPSTREAM, RC_LOG_DIR: RUN_DIR },
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(join(RUN_DIR, "caddy.pid"), String(caddyChild.pid));
  caddyChild.on("error", (e) => { pushEvent("down", "caddy 启动失败：" + e.message); say(ctx, "error", "[dsh-remote] caddy error: " + e.message); });
  caddyChild.on("exit", () => {
    if (stopping) return; // 命令式停止：不是崩溃，不重拉
    if (!alive()) return;
    if (cfg.autoRestart === false) {
      if (urlTimer) { clearInterval(urlTimer); urlTimer = null; } // 不重拉就别再轮询已死进程的地址（审查 P2）
      pushEvent("down", "caddy 退出（自动重启已关闭）");
      return;
    }
    pushEvent("down", "caddy 退出，5s 后自动重拉");
    const t = setTimeout(() => { timers.delete(t); if (alive() && cfg.autoRestart !== false) spawnCaddy(ctx); }, RESPAWN_DELAY_MS);
    timers.add(t);
  });
}

function spawnCloudflared(ctx: AnyCtx): void {
  const alive = () => fiberAlive?.() ?? false;
  if (urlTimer) { clearInterval(urlTimer); urlTimer = null; }
  const logFile = join(RUN_DIR, "cloudflared.log");
  writeFileSync(logFile, ""); // fresh log：URL grep 只看本次
  const out = openSync(logFile, "a");
  cloudflaredChild = spawn(findBinary(cfg, "cloudflared"),
    ["tunnel", "--url", TUNNEL_ENTRY, "--no-autoupdate", "--protocol", "http2"],
    { stdio: ["ignore", out, out] });
  writeFileSync(join(RUN_DIR, "cloudflared.pid"), String(cloudflaredChild.pid));
  say(ctx, "info", `[dsh-remote] cloudflared spawning (pid ${cloudflaredChild.pid})`);

  const startedAt = Date.now();
  let announced = ""; // 每次 spawn 独立捕获（审查二轮 P2-3：无新 URL 时 45s 超时语义正确）
  currentUrl = ""; // spawn 时清空：死链接不留在 state（审查二轮 P2-3）
  urlTimer = setInterval(() => {
    const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== lastAnnouncedUrl) {
      const changed = lastAnnouncedUrl !== "";
      announced = m[0]; currentUrl = m[0]; lastAnnouncedUrl = m[0];
      writeFileSync(join(RUN_DIR, "url"), m[0] + "\n");
      say(ctx, "info", `[dsh-remote] tunnel ${changed ? "changed" : "up"}: ${m[0]}`);
      pushEvent(changed ? "changed" : "started", m[0]);
      void sendNotify(ctx, changed ? "changed" : "started", m[0]);
      // 不 clear：changed 检测需要持续监听（watchdog 语义）；disposer 统一清理
    } else if (!announced && Date.now() - startedAt > URL_TIMEOUT_MS) {
      clearInterval(urlTimer!); urlTimer = null;
      say(ctx, "warn", `[dsh-remote] no URL within 45s — see ${logFile}`);
      pushEvent("down", "45s 内未捕获到 URL");
    }
  }, 2000);

  cloudflaredChild.on("error", (e) => { pushEvent("down", "cloudflared 启动失败：" + e.message); say(ctx, "error", "[dsh-remote] cloudflared error: " + e.message); });
  cloudflaredChild.on("exit", () => {
    closeSync(out);
    if (stopping) return; // 命令式停止：不是崩溃，不重拉不通知
    if (!alive()) return;
    if (cfg.autoRestart === false) {
      if (urlTimer) { clearInterval(urlTimer); urlTimer = null; } // 不重拉就别再轮询已死进程的地址（审查 P2）
      pushEvent("down", "cloudflared 退出（自动重启已关闭）"); say(ctx, "warn", "[dsh-remote] cloudflared exited, auto-restart off");
      return;
    }
    pushEvent("down", "cloudflared 退出，5s 后自动重拉（quick tunnel 会自己死，事实 13）");
    void sendNotify(ctx, "down", currentUrl || null);
    const t = setTimeout(() => { timers.delete(t); if (alive() && cfg.autoRestart !== false) spawnCloudflared(ctx); }, RESPAWN_DELAY_MS);
    timers.add(t);
  });
}

// ---------- 命令式启停（toggle 用；不动 profile = 不触发条目重启） ----------

async function startTunnel(ctx: AnyCtx): Promise<void> {
  if (cloudflaredChild?.pid && pidAlive(cloudflaredChild.pid)) return; // 已在跑（双击防抖）
  stopping = false;
  await reapOrphans(ctx);
  spawnCaddy(ctx);
  spawnCloudflared(ctx);
}

function stopTunnel(ctx: AnyCtx): void {
  if (!cloudflaredChild && !caddyChild) { currentUrl = ""; return; }
  stopping = true;
  if (urlTimer) { clearInterval(urlTimer); urlTimer = null; }
  for (const t of timers) clearTimeout(t);
  timers.clear();
  try { if (caddyChild?.pid) process.kill(caddyChild.pid); } catch { /* gone */ }
  try { if (cloudflaredChild?.pid) process.kill(cloudflaredChild.pid); } catch { /* gone */ }
  caddyChild = null; cloudflaredChild = null; currentUrl = "";
  for (const f of ["caddy.pid", "cloudflared.pid", "url"]) { try { rmSync(join(RUN_DIR, f)); } catch { /* absent */ } }
  pushEvent("down", "远程访问已停止（链接已失效）");
  say(ctx, "info", "[dsh-remote] tunnel + gate stopped by owner");
}

function renderCaddyfile(): string {
  // 语义照抄 v0.3.x etc/Caddyfile（:4080 而非 127.0.0.1:4080；Cookie 正则门；Host/Origin 重写；
  // {$VAR} 适配期替换）。新增：/rc-api/* 直达插件 listener（远端须过门，本机 loopback 直过）。
  return `{
	admin off
	auto_https off
	log {
		output file ${JSON.stringify(join(RUN_DIR, "caddy.log"))}
		level WARN
	}
}

:4080 {
	bind 127.0.0.1
	# 访问日志：定位"远程 403"到底有没有到我们的门（没到 = 网络路径被拦）
	log {
		output file ${JSON.stringify(join(RUN_DIR, "access.log"))} {
			roll_size 1MiB
			roll_keep 2
		}
		level INFO
	}
	# rc_session = 签名会话令牌（v1.<exp>.<sig>）：门只做格式匹配，签名与过期在插件侧 /rc-api 校验（审查 #47）
	# rc_session 存在才走门（无 cookie → 登录页）；门内先 forward_auth 到插件做真实校验
	# （签名 + 过期），伪造/过期/重置前令牌一律 401（审查三轮 P1-1：格式匹配 ≠ 授权）。
	@authed header_regexp Cookie rc_session=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+
	@login path /rc-login
	@api path /rc-api/*
	@localapi remote_ip 127.0.0.1

	handle @login {
		reverse_proxy 127.0.0.1:${LOGIN_PORT}
	}

	handle @api {
		# 远端 /rc-api 的授权在插件侧 classify（cf-connecting-ip 存在=远端 → rc_session 校验）；
		# cloudflared→Caddy 的 remote_ip 恒为 127.0.0.1，@localapi 恒先命中——内层不再分支。
		handle @localapi {
			reverse_proxy 127.0.0.1:${LOGIN_PORT}
		}
		handle {
			header Location /rc-login
			respond 302
		}
	}

	handle @authed {
		# 真实会话校验（审查三轮 P1-1）：Caddy 先把原始头（含 Cookie）转发给插件 /rc-auth，
		# verifySession 通过才放行到 DSH；删除 dsh-auth 单独放行路径（重置密码语义，审查三轮 P1-2）。
		forward_auth 127.0.0.1:${LOGIN_PORT} {
			uri /rc-auth
		}
		reverse_proxy ${UPSTREAM} {
			# 过期/无效的 dsh-auth cookie：DSH 回 401/403 → 送回登录页（杜绝死路 403）
			@fence status 401 403
			handle_response @fence {
				error 401 "fence"
			}
			header_up Host ${UPSTREAM_HOST}
			header_up Origin http://${UPSTREAM_HOST}
		}
	}

	handle {
		header Location /rc-login
		respond 302
	}

	handle_errors {
		handle {
			header Location /rc-login
			respond 302
		}
	}
}
`;
}

// ---------- apply ----------

export function apply(ctx: AnyCtx, config: Config = {}) {
  (globalThis as any).__dshRemoteCtx = ctx; // secrets helpers need ctx without threading it everywhere
  // loadSettings 的 I/O 错误（EACCES/EIO）向上抛到这里：插件降级为默认配置并明确上报，不静默清盘（审查三轮 P1-2）
  try {
    cfg = { ...config, ...loadSettings() } as Config;
  } catch (error) {
    cfg = { ...config } as Config;
    say(ctx, "error", "[dsh-remote] settings.json 读取失败，已用默认配置启动：" + (error as Error).message);
  }
  mkdirSync(RUN_DIR, { recursive: true });

  // 生命周期整体挂 ctx.effect（事实 14）：setup 现在跑，disposer 在 fiber 销毁时跑。
  // dead/isAlive 是本条 fiber 的生命旗标——所有异步路径（boot 的 await 间隙、respawn 定时器、
  // 命令式启停）都必须检查，否则 fiber 销毁后仍会拉起进程（第 1 轮自审 P1-2 的根因）。
  // 管理 listener（登录页 + /rc-api）常驻：不随隧道启停——否则停止后连"启动按钮"都没有。
  ctx.effect(() => {
    materializeCli(ctx); // dsh-web 命令物化（软链；幂等；disposer 不删——见上方设计决策）
    let dead = false;
    const isAlive = () => !dead;
    fiberAlive = isAlive;

    const boot = async () => {
      await ensureSecrets(ctx);
      if (!isAlive()) return;
      loginServer = startLoginServer(ctx);
      // 启动期 entry 重启竞态：上一代 fiber 的 listener 释放有延迟，重试而不是失败
      for (let attempt = 0; ; attempt++) {
        try {
          await new Promise<void>((resolve, reject) => {
            loginServer!.once("error", reject);
            loginServer!.listen(LOGIN_PORT, "127.0.0.1", () => resolve());
          });
          break;
        } catch (e) {
          if (attempt >= 5 || !isAlive() || String((e as Error).message).indexOf("EADDRINUSE") < 0) throw e;
          say(ctx, "warn", "[dsh-remote] 9091 暂被上一代 fiber 占用，500ms 后重试");
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!isAlive()) { try { loginServer!.close(); } catch { /* not listening */ } loginServer = null; return; }
      say(ctx, "info", `[dsh-remote] login/api listening on 127.0.0.1:${LOGIN_PORT}`);
      // 跟随启动模式：每次宿主启动自动拉起隧道（URL 捕获后会经飞书推送 started 通知）；
      // 手动模式：隧道保持停止，等用户在管理面点「启动」。
      if (cfg.autoStart !== true) return; // idle：管理面在，隧道不在
      await reapOrphans(ctx);
      if (!isAlive()) return;
      spawnCaddy(ctx);
      spawnCloudflared(ctx);
      cfg = { ...cfg, enabled: true } as Config; // autoStart 拉起后同步状态（审查 #48：cfg 与实际一致）
      saveSettings();
    };
    boot().catch((e) => {
      say(ctx, "error", "[dsh-remote] 启动失败：" + (e as Error).message);
      pushEvent("down", "启动失败：" + (e as Error).message);
    });

    return () => { // disposer
      dead = true;
      fiberAlive = null;
      if (urlTimer) { clearInterval(urlTimer); urlTimer = null; }
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try { if (caddyChild?.pid) process.kill(caddyChild.pid); } catch { /* gone */ }
      try { if (cloudflaredChild?.pid) process.kill(cloudflaredChild.pid); } catch { /* gone */ }
      try { loginServer?.close(); } catch { /* closed */ }
      caddyChild = null; cloudflaredChild = null; loginServer = null; currentUrl = "";
      for (const f of ["caddy.pid", "cloudflared.pid", "url"]) { try { rmSync(join(RUN_DIR, f)); } catch { /* absent */ } }
      say(ctx, "info", "[dsh-remote] tunnel + gate + login server stopped, state cleaned");
    };
  });
}
