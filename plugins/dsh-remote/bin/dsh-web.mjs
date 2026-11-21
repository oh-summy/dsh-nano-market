#!/usr/bin/env node
// @oh-summy/dsh-remote — dsh-web CLI（瘦客户端，只用 node 内置，无第三方依赖）
//
// 语义（issue #29 + 补充评论 2026-11-20）：
//   裸 dsh-web = start：后台拉起 DSH（detached，终端可关）→ 起隧道 → 打印 URL + 密码 + 速查表。
//   插件是唯一入口——三态探测（顺序不可调换）：
//     1) 插件包在不在（profile node_modules/@oh-summy/dsh-remote）
//     2) 插件 entry 是否 enabled（profile cordis.patch.yml 的 - id: dsh-remote 块）
//     3) 本机 API 通不通（127.0.0.1:9091/rc-api/state）
//   两个开关不要混：装载开关（entry enabled）决定命令是否存在；
//   隧道运行时开关（插件 settings.json 的 enabled）决定隧道在不在——start 里经 /rc-api/toggle 打开。
// 测试性：fs/fetch/spawn/时钟全部经 deps 注入（createDeps 的 overrides），单测不打真机。

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const API_ORIGIN = "http://127.0.0.1:9091";
export const DSH_PORT = 3080; // 硬约束：插件 Caddy 上游写死 127.0.0.1:3080，不得改端口
const GATE_PORT = 4080;  // stop 终验对象：caddy 门
const LOGIN_PORT = 9091; // stop 终验对象：登录页/管理 API（随 DSH 进程消失）

// ---------- 命令速查表（每条命令执行完都追加；help 只打印它） ----------

export const COMMANDS = [
  { cmd: "dsh-web", desc: "启动：后台拉起 DSH（终端可关）+ 开隧道，打印访问地址与密码（幂等）" },
  { cmd: "dsh-web help", desc: "只看这张命令速查表" },
  { cmd: "dsh-web stop", desc: "停隧道（本机 API）+ 停 DSH（launchd 在管时卸载 agent，防止 KeepAlive 复活）" },
  { cmd: "dsh-web restart", desc: "重启：stop → start" },
  { cmd: "dsh-web status", desc: "DSH 进程 / 插件装载 / 隧道 / 通知通道 / 开机自启 agent" },
  { cmd: "dsh-web url", desc: "当前公网入口 URL" },
  { cmd: "dsh-web password", desc: "访问密码明文（仅本机打印）" },
  { cmd: "dsh-web logs [caddy|cloudflared|access|dsh]", desc: "尾部日志（默认 cloudflared）" },
];

export function renderCheatsheet() {
  const rows = COMMANDS.map((c) => "  " + c.cmd.padEnd(46) + c.desc).join("\n");
  return "\n命令速查表（dsh-web）\n" + rows;
}

// ---------- 可注入依赖 ----------

export function createDeps(overrides = {}) {
  const out = overrides.out ?? ((s) => process.stdout.write(s + "\n"));
  const deps = {
    homedir: overrides.homedir ?? (() => os.homedir()),
    env: overrides.env ?? process.env,
    existsSync: overrides.existsSync ?? ((p) => fs.existsSync(p)),
    readFileSync: overrides.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc)),
    realpathSync: overrides.realpathSync ?? ((p) => fs.realpathSync(p)),
    mkdirSync: overrides.mkdirSync ?? ((p, o) => fs.mkdirSync(p, o)),
    openSync: overrides.openSync ?? ((p, f) => fs.openSync(p, f)),
    closeSync: overrides.closeSync ?? ((fd) => fs.closeSync(fd)),
    fetch: overrides.fetch ?? fetch,
    spawn: overrides.spawn ?? nodeSpawn, // spawn 原语可注入：单测据此验证 detached 契约
    spawnSync: overrides.spawnSync ?? nodeSpawnSync,
    kill: overrides.kill ?? ((pid, sig) => process.kill(pid, sig)),
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: overrides.now ?? (() => performance.now()), // 单调时钟：Date.now 会受系统回拨影响
    out,
    err: overrides.err ?? ((s) => process.stderr.write(s + "\n")),
    apiTimeoutMs: overrides.apiTimeoutMs ?? 4000,
    startWaitMs: overrides.startWaitMs ?? 180_000, // DSH 冷启动就绪超时（launchd 拉起窗口实测可超 90s）
    startPollStepMs: overrides.startPollStepMs ?? 1000,
    urlWaitMs: overrides.urlWaitMs ?? 50_000, // 等 URL（插件侧 URL_TIMEOUT_MS=45s）
    tailLines: overrides.tailLines ?? 40,
  };
  return deps;
}

// detached + unref：父终端关闭后 DSH 仍存活；stdin ignore，stdout/stderr 落盘。
// spawn 同步异常由调用方（cmdStart）兜底；异步 error（ENOENT/EACCES）在此落地为带指引的错误。
function defaultSpawnDsh(deps, { dshBin, logDir }) {
  deps.mkdirSync(logDir, { recursive: true });
  let outFd = -1, errFd = -1;
  try {
    outFd = deps.openSync(path.join(logDir, "dsh-web.cli.out.log"), "a");
    errFd = deps.openSync(path.join(logDir, "dsh-web.cli.err.log"), "a");
    const child = deps.spawn(dshBin, ["web", "--no-open"], {
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.on("error", (e) => {
      deps.err("✗ DSH 后台进程异常退出：" + e.message + "\n" +
        "  下一步：看 " + path.join(logDir, "dsh-web.cli.err.log") + "；或前台跑 dsh web 看真实报错");
    });
    child.unref();
    return child;
  } finally {
    if (outFd >= 0) deps.closeSync(outFd); // 子进程已继承 fd，父进程即时关闭无碍
    if (errFd >= 0) deps.closeSync(errFd);
  }
}

// ---------- 路径（DSH_HOME 优先，缺省 ~/.dsh） ----------

function paths(deps) {
  const home = deps.homedir();
  const dshHome = deps.env.DSH_HOME || path.join(home, ".dsh");
  const profileDir = path.join(dshHome, "profiles", "web");
  return {
    home,
    dshHome,
    profileDir,
    pluginDir: path.join(profileDir, "node_modules", "@oh-summy", "dsh-remote"),
    patchFile: path.join(profileDir, "cordis.patch.yml"),
    runDir: path.join(home, ".remote-control", "run-plugin"),
    dshLogDir: path.join(dshHome, "logs"),
  };
}

// ---------- 三态探测（顺序不可调换：包 → entry enabled → API） ----------

export function readPatchEntry(deps, patchFile) {
  let text;
  try { text = deps.readFileSync(patchFile, "utf8"); }
  catch { return { found: false, enabled: false, raw: null, reason: "cordis.patch.yml 不存在" }; }
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === "- id: dsh-remote") { start = i; break; }
  if (start < 0) return { found: false, enabled: false, raw: null, reason: "dsh-remote 块缺失" };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^(\s*)- /.test(lines[i])) { end = i; break; }
  const blockText = lines.slice(start, end).join("\n");
  const grab = (re) => { const m = re.exec(blockText); return m ? m[1].trim() : null; };
  // entry 级 enabled（2 空格缩进）优先；否则认 config 块内的 enabled（≥4 空格缩进）
  const raw = grab(/^[ ]{2}enabled:[ \t]*(\S+)/m) ?? grab(/^[ ]{4,}enabled:[ \t]*(\S+)/m);
  return { found: true, enabled: raw === "true", raw, reason: raw === null ? "enabled 键缺失" : undefined };
}

async function apiCall(deps, pathname, opts = {}) {
  const res = await deps.fetch(API_ORIGIN + pathname, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? deps.apiTimeoutMs),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function detectState(deps) {
  const p = paths(deps);
  if (!deps.existsSync(p.pluginDir)) return { ...p, state: "not-installed", entry: null, apiState: null };
  const entry = readPatchEntry(deps, p.patchFile);
  if (!entry.enabled) return { ...p, state: "disabled", entry, apiState: null };
  let apiState = null;
  try { apiState = await apiCall(deps, "/rc-api/state"); }
  catch { return { ...p, state: "dsh-down", entry, apiState: null }; }
  return { ...p, state: "ready", entry, apiState };
}

function gateMessages(st) {
  return {
    "not-installed":
      "✗ 插件未安装：找不到 " + st.pluginDir + "\n" +
      "  下一步：dsh plugin --profile web add @oh-summy/dsh-remote（装好后命令随插件物化）",
    "disabled":
      "✗ 插件未打开（entry enabled=false，命令不应存在）\n" +
      "  下一步：Plugins → Nano Market → dsh-remote → 配置 → 打开 enabled，然后重启宿主（dsh-web restart）",
  };
}

// ---------- 进程侦察（stop/status 用） ----------

// 返回 { state: "none" | "found" | "error", pid }：区分「无监听」和「侦察失败」——
// lsof 不可用时绝不把失败当成「没在跑」（否则 stop 会静默放过真 DSH）。
function portOwner(deps, port) {
  const r = deps.spawnSync("lsof", ["-nP", "-ti", "tcp:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (r.error) return { state: "error", pid: 0 };
  if (r.status === 0) {
    const line = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)[0];
    const pid = line ? parseInt(line, 10) : 0;
    return { state: Number.isFinite(pid) && pid > 0 ? "found" : "none", pid };
  }
  if (r.status === 1) return { state: "none", pid: 0 }; // 明确的「无匹配」（lsof -t 无命中退出码 1）
  return { state: "error", pid: 0 }; // 其余退出码（权限/用法错误）= 侦察失败，绝不当作无监听
}

function procArgs(deps, pid) {
  const r = deps.spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

function procName(deps, pid) {
  const r = deps.spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  return (r.stdout || "").trim().split("/").pop() || "";
}

function procAlive(deps, pid) {
  const r = deps.spawnSync("ps", ["-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").split("\n").length > 1;
}

// DSH 身份判定（收紧版）：不搜整行命令行，核对真实可执行入口——
// 解释器（node 等）后面那个 token 才是入口；入口必须是 dsh 可执行文件
// （basename === "dsh"，或路径在 @deepseek-ai/dsh 包内），且带 web 子命令（或不带任何参数）。
// 反例 "python worker.py dsh --port 3080" 的入口是 worker.py → 不判为 DSH。
const INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "bash", "sh"]);

// 可信 DSH 入口集合：which dsh 与 ~/.npm-global/bin/dsh 的 realpath。
// 身份判定只认「与可信入口 realpath 相等」的进程——任意路径下 basename 叫 dsh 的脚本不算。
function trustedDshPaths(deps) {
  const trusted = new Set();
  const r = deps.spawnSync("which", ["dsh"], { encoding: "utf8" });
  if (r.status === 0) {
    const p = (r.stdout || "").trim();
    if (p) { try { trusted.add(deps.realpathSync(p)); } catch { trusted.add(p); } }
  }
  const fallback = path.join(deps.homedir(), ".npm-global", "bin", "dsh");
  if (deps.existsSync(fallback)) {
    try { trusted.add(deps.realpathSync(fallback)); } catch { trusted.add(fallback); }
  }
  return trusted;
}

// DSH 身份判定：解释器（node 等）后面那个 token 才是真实入口；
// 入口 realpath 必须命中可信 DSH 入口集合；且第一个子命令是 web（或不带任何参数）。
// 反例：python /tmp/dsh web、bash /tmp/dsh web、node /tmp/dsh web、python worker.py dsh --port 3080 —— 全部拒绝。
function isDshProcess(deps, args, trusted = trustedDshPaths(deps)) {
  const parts = String(args).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  let entry = parts[0];
  let rest = parts.slice(1);
  if (INTERPRETERS.has(entry.split("/").pop().toLowerCase()) && rest.length > 0) {
    entry = rest[0];
    rest = rest.slice(1);
  }
  let real;
  try { real = deps.realpathSync(entry); } catch { return false; } // 入口不存在（进程正退出）→ 不判定为 DSH
  if (!trusted.has(real)) return false;
  return rest.length === 0 || rest[0] === "web"; // web 必须在子命令位，不搜整行
}

// API 不可达时插件回收不了自己的子进程：按 RUN_DIR 的 pid 文件兜底（核对进程名，绝不误杀）
function reapChildren(deps, st) {
  const reaped = [];
  for (const name of ["caddy", "cloudflared"]) {
    let pid = 0;
    try { pid = parseInt(String(deps.readFileSync(path.join(st.runDir, name + ".pid"), "utf8")).trim(), 10); } catch { /* absent */ }
    if (!(pid > 0) || !procAlive(deps, pid)) continue;
    if (procName(deps, pid) !== name) continue; // PID 复用给了别的程序
    try { deps.kill(pid, "SIGTERM"); reaped.push(name + "（pid " + pid + "）"); } catch { /* gone */ }
  }
  return reaped;
}

// stop 终验：3080/4080/9091 全部明确无监听 + 兜底回收的子进程确实不在。
// 任何 found / error 都算未清理干净——不干净就不报成功。
function verifyStopClean(deps, st) {
  const leftovers = [];
  for (const port of [DSH_PORT, GATE_PORT, LOGIN_PORT]) {
    const own = portOwner(deps, port);
    if (own.state === "found") leftovers.push("端口 " + port + " 仍有监听（pid " + own.pid + " → " + procArgs(deps, own.pid) + "）");
    else if (own.state === "error") leftovers.push("端口 " + port + " 状态无法确认（lsof 不可用）");
  }
  leftovers.push(...survivingChildren(deps, st).map((s) => s + " 仍在运行"));
  return leftovers;
}

async function waitChildrenGone(deps, st, budgetMs = 3000) {
  const deadline = deps.now() + budgetMs;
  for (;;) {
    if (survivingChildren(deps, st).length === 0) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(200);
  }
}

// 所有清理路径共用一个出口：终验决定退出码，不允许任何分支提前报成功
async function finishStop(deps, st, opts) {
  const leftovers = verifyStopClean(deps, st);
  if (leftovers.length > 0) {
    deps.err("✗ stop 未清理干净：" + leftovers.join("；") + "\n" +
      "  下一步：按上面的 pid 逐个确认（可能是 PID 复用或外部拉起），处理后再 dsh-web status 复核");
    if (opts.sheet !== false) deps.out(renderCheatsheet());
    return 1;
  }
  if (opts.sheet !== false) deps.out(renderCheatsheet());
  return 0;
}

// 兜底回收后仍存活的插件子进程（终验用）
function survivingChildren(deps, st) {
  const alive = [];
  for (const name of ["caddy", "cloudflared"]) {
    let pid = 0;
    try { pid = parseInt(String(deps.readFileSync(path.join(st.runDir, name + ".pid"), "utf8")).trim(), 10); } catch { /* absent */ }
    if (!(pid > 0) || !procAlive(deps, pid)) continue;
    if (procName(deps, pid) === name) alive.push(name + "（pid " + pid + "）");
  }
  return alive;
}

// launchd agent（开机自启）探测：job 存在 = DSH 的启停归 launchd 管——
// start 在 dsh-down 时只等待、不 spawn，避免与 launchd 的 KeepAlive 重拉赛跑出双实例
//（实测事故：重启窗口期裸 dsh-web 与 launchd 各起一个实例，抢 3080/9091，CLI 90s 误报超时）。
function launchdDshJob(deps) {
  const uidR = deps.spawnSync("id", ["-u"], { encoding: "utf8" });
  const uid = uidR.status === 0 ? uidR.stdout.trim() : "";
  if (!uid) return { exists: false, running: false, pid: 0, uid: "" };
  const r = deps.spawnSync("launchctl", ["print", "gui/" + uid + "/com.deepseek.dsh-web"], { encoding: "utf8" });
  if (r.status !== 0) return { exists: false, running: false, pid: 0, uid };
  const text = (r.stdout || "") + (r.stderr || "");
  const pidM = /^[ \t]*pid = (\d+)/m.exec(text);
  const stateM = /^[ \t]*state = (\S+)/m.exec(text);
  return { exists: true, running: stateM ? stateM[1] === "running" : false, pid: pidM ? parseInt(pidM[1], 10) : 0, uid };
}

// agent plist 路径（install-autostart.sh 安装的那个）
function agentPlist(deps) {
  return path.join(deps.homedir(), "Library", "LaunchAgents", "com.deepseek.dsh-web.plist");
}

function findDshBin(deps) {
  const r = deps.spawnSync("which", ["dsh"], { encoding: "utf8" });
  if (r.status === 0) { const p = (r.stdout || "").trim(); if (p) return p; }
  const fallback = path.join(deps.homedir(), ".npm-global", "bin", "dsh");
  if (deps.existsSync(fallback)) return fallback;
  return null;
}

// ---------- 各命令 ----------

// deadline 式轮询：按注入时钟算真实剩余预算，单次请求的 abort 不超过剩余时间——
// 避免「累计 sleep 名义 90s、实际含请求耗时拖到 450s」的失真。
async function pollUntil(deps, budgetMs, tryOnce, onTick) {
  const deadline = deps.now() + budgetMs;
  const startedAt = deps.now();
  let lastTick = -Infinity;
  for (;;) {
    const left = deadline - deps.now();
    if (left <= 0) return false;
    await deps.sleep(Math.min(deps.startPollStepMs, left));
    const left2 = deadline - deps.now();
    if (left2 <= 0) return false; // 耗尽即停：不发越界请求
    if (onTick) {
      const elapsed = deps.now() - startedAt;
      if (elapsed - lastTick >= 5000) { lastTick = elapsed; onTick(elapsed); }
    }
    try {
      const hit = await tryOnce(left2);
      if (hit) return deps.now() <= deadline; // 命中但已越过 deadline 的晚到结果 = 失败
    } catch { /* 瞬断重试 */ }
  }
}

async function cmdStart(deps, st, opts = {}) {
  const out = deps.out, err = deps.err;
  const sheet = () => { if (opts.sheet !== false) out(renderCheatsheet()); };
  let apiState = st.state === "ready" ? st.apiState : null;
  if (st.state === "dsh-down") {
    const job = launchdDshJob(deps);
    const plist = agentPlist(deps);
    if (job.exists && job.running) {
      // launchd 在管：绝不另起实例（双实例抢 3080/9091），只等 launchd 拉起的那个就绪
      out("ℹ 检测到 launchd 正在管理 DSH（com.deepseek.dsh-web，pid " + job.pid + "）——等待它就绪，不另起实例");
    } else if (!job.exists && deps.existsSync(plist)) {
      // agent 已安装但未装载（上次 stop bootout 卸载了它）：bootstrap 重新装载，仍由 launchd 拉起
      out("ℹ 检测到 launchd agent 已安装未装载——bootstrap 重新装载，由 launchd 拉起 DSH");
      const bs = deps.spawnSync("launchctl", ["bootstrap", "gui/" + job.uid, plist], { encoding: "utf8" });
      if (bs.status !== 0) {
        err("✗ launchctl bootstrap 失败：" + ((bs.stderr || "").trim() || (bs.error && bs.error.message) || "exit " + bs.status) + "\n" +
          "  下一步：手动 launchctl bootstrap gui/$(id -u) " + plist + "；或前台跑 dsh web");
        sheet();
        return 1;
      }
    } else {
      const dshBin = findDshBin(deps);
      if (!dshBin) {
        err("✗ 找不到 dsh 命令——先安装 DeepSeek Harness（npm i -g @deepseek-ai/dsh），再跑 dsh-web");
        sheet();
        return 1;
      }
      try {
        defaultSpawnDsh(deps, { dshBin, logDir: st.dshLogDir });
      } catch (e) {
        err("✗ 后台拉起 DSH 失败：" + e.message + "\n  下一步：前台跑 dsh web 看真实报错");
        sheet();
        return 1;
      }
      out("🚀 DSH 未在运行——已在后台拉起（detached，终端可以直接关闭；日志：" + st.dshLogDir + "/dsh-web.cli.*.log）");
    }
    const ok = await pollUntil(deps, deps.startWaitMs, async (left) => {
      apiState = await apiCall(deps, "/rc-api/state", { timeoutMs: left });
      return true; // API 一通即视为就绪（装载与隧道状态在后续阶段判断）
    }, (s) => out("⏳ 等待 DSH 就绪…" + Math.round(s / 1000) + "s"));
    if (!ok || !apiState) {
      err("✗ 等待 DSH 就绪超时（" + deps.startWaitMs / 1000 + "s）——插件 API（127.0.0.1:9091）没有应答\n" +
        (job.exists && job.running
          ? "  下一步：launchctl print gui/$(id -u)/com.deepseek.dsh-web 看 agent 状态；或 launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web 强制重启"
          : "  下一步：dsh-web logs dsh 看启动日志；或前台跑 dsh web 看真实报错"));
      sheet();
      return 1;
    }
    out("✅ DSH 就绪，插件已装载");
  } else {
    out("✅ DSH 已在运行（幂等：不重复拉起第二个实例）");
  }
  if (!apiState.running) {
    out("🔌 隧道未开启——正在通过本机 API 打开（运行时开关，与插件装载开关是两回事）…");
    try { await apiCall(deps, "/rc-api/toggle", { method: "POST" }); }
    catch (e) {
      err("✗ 打开隧道失败：" + e.message + "\n" +
        "  下一步：DSH → Plugins → Nano Market → dsh-remote → 配置 → 点「启动」");
      sheet();
      return 1;
    }
  }
  // 统一等 URL——无论隧道是刚 toggle 的、autoStart 已在跑但还没捕获到 URL（running=true,url=""），
  // 最终必须拿到非空 URL 才算成功，绝不打印空入口。
  let got = false;
  const waited = await pollUntil(deps, deps.urlWaitMs, async (left) => {
    apiState = await apiCall(deps, "/rc-api/state", { timeoutMs: left });
    return !!apiState.url;
  }, (s) => out("⏳ 等待隧道 URL…" + Math.round(s / 1000) + "s"));
  if (!waited || !apiState.url) {
    err("✗ " + deps.urlWaitMs / 1000 + "s 内没拿到隧道 URL（隧道进程可能没起来或 quick tunnel 暂慢）\n" +
      "  下一步：dsh-web logs cloudflared 看隧道日志；稍后再跑 dsh-web url");
    sheet();
    return 1;
  }
  const url = apiState.url;
  let password = null;
  try { password = (await apiCall(deps, "/rc-api/reveal", { method: "POST" })).password; }
  catch (e) {
    err("✗ 密码获取失败：" + e.message + "\n" +
      "  下一步：确认 DSH 在跑（dsh-web status）；或在插件详情页查看密码（Plugins → Nano Market → dsh-remote → 配置）");
    sheet();
    return 1; // start 成功的定义 = URL + 密码都拿到；缺密码不算成功
  }
  out("\n🌐 公网入口：" + url);
  out("🔑 访问密码：" + password);
  sheet();
  return 0;
}

async function cmdStop(deps, st, opts = {}) {
  const out = deps.out, err = deps.err;
  let tunnelConfirmed = false;
  if (st.state === "ready") {
    if (st.apiState.running) {
      try {
        await apiCall(deps, "/rc-api/toggle", { method: "POST" });
        out("🔌 隧道已停止（API toggle，caddy/cloudflared 由插件回收）");
        tunnelConfirmed = true;
      } catch (e) {
        err("⚠ 停隧道失败：" + e.message + "（继续停 DSH；收尾按 pid 文件兜底回收子进程）");
      }
    } else {
      out("🔌 隧道本来就没在跑");
      tunnelConfirmed = true;
    }
  } else {
    out("ℹ 插件 API 不可达（DSH 未运行或未装载）——停 DSH 后按 pid 文件兜底回收子进程");
  }
  const job = launchdDshJob(deps);
  if (job.exists) {
    // 实测事故（2026-11-21）：直接 kill 会被 KeepAlive 立即复活并抢占 3080，导致「已停止」是假的、
    // 手动 dsh web 撞 EADDRINUSE。正确停法 = 停隧道后 bootout 卸载 agent，让 DSH 真正停下。
    out("ℹ DSH 由 launchd 管理（com.deepseek.dsh-web）——卸载 agent（bootout），防止 KeepAlive 复活");
    const bo = deps.spawnSync("launchctl", ["bootout", "gui/" + job.uid + "/com.deepseek.dsh-web"], { encoding: "utf8" });
    if (bo.status === 0) {
      const freed = await pollUntil(deps, 15_000, async () => portOwner(deps, DSH_PORT).state === "none");
      if (freed) {
        out("✅ DSH 已停止（agent 已卸载，KeepAlive 不会复活；下次跑 dsh-web 会自动重新装载）");
        reapChildren(deps, st);
        await waitChildrenGone(deps, st);
        return finishStop(deps, st, opts);
      }
      err("⚠ bootout 后 3080 仍未释放——回退为按属主核对终止");
    } else {
      err("⚠ launchctl bootout 失败：" + ((bo.stderr || "").trim() || (bo.error && bo.error.message) || "exit " + bo.status) + "（回退为按属主核对终止）");
    }
  }
  const own = portOwner(deps, DSH_PORT);
  if (own.state === "error") {
    err("✗ 无法确认端口 " + DSH_PORT + " 的属主（lsof 不可用？）——为避免误杀，本次不终止 DSH；插件子进程仍按 pid 文件兜底回收");
    reapChildren(deps, st);
    await waitChildrenGone(deps, st);
    return finishStop(deps, st, opts); // 终验决定退出码：子进程没死透也不算成功
  }
  if (own.state === "none") {
    out("✅ 端口 " + DSH_PORT + " 无监听——DSH 未在运行");
    reapChildren(deps, st);
    if (!tunnelConfirmed) err("⚠ 隧道停用请求失败——caddy/cloudflared 可能残留，以下终验为准");
    await waitChildrenGone(deps, st); // 有界等待兜底回收生效，而不是发完 SIGTERM 就报成功
    return finishStop(deps, st, opts);
  }
  const pid = own.pid;
  const trusted = trustedDshPaths(deps);
  if (trusted.size === 0) {
    err("✗ 无法核实 DSH 身份（找不到可信的 dsh 入口）——拒绝终止任何进程\n" +
      "  下一步：确认 DeepSeek Harness 安装正常（which dsh）；处理后再跑 dsh-web stop");
    reapChildren(deps, st);
    await waitChildrenGone(deps, st);
    return finishStop(deps, st, opts);
  }
  const args = procArgs(deps, pid);
  if (!isDshProcess(deps, args, trusted)) {
    err("✗ 端口 " + DSH_PORT + " 的属主不是 DSH，拒绝终止：pid " + pid + " → " + (args || "（未知命令行）") + "\n" +
      "  下一步：确认该进程是什么；若确属 DSH 残留，手动处理后再跑 dsh-web stop");
    if (opts.sheet !== false) out(renderCheatsheet());
    return 1;
  }
  try { deps.kill(pid, "SIGTERM"); } catch { /* gone */ }
  let gone = false;
  for (const deadline = deps.now() + 5000; deps.now() < deadline;) {
    await deps.sleep(200);
    if (!procAlive(deps, pid)) { gone = true; break; }
  }
  if (!gone) {
    // SIGKILL 前重核身份：等待期间 PID 可能被复用给别人
    const args2 = procArgs(deps, pid);
    if (!isDshProcess(deps, args2, trusted)) {
      err("✗ pid " + pid + " 在等待退出期间易主（现为：" + (args2 || "?") + "）——不升级 SIGKILL\n" +
        "  下一步：人工确认 pid " + pid + " 现属谁；DSH 若换 pid 重现，再跑 dsh-web stop");
      reapChildren(deps, st);
      await waitChildrenGone(deps, st);
      return finishStop(deps, st, opts);
    }
    try { deps.kill(pid, "SIGKILL"); } catch { /* gone */ }
    out("（5s 未退出，已升级 SIGKILL）");
    for (const deadline2 = deps.now() + 3000; deps.now() < deadline2;) {
      await deps.sleep(200);
      if (!procAlive(deps, pid)) { gone = true; break; }
    }
    if (!gone) {
      err("✗ SIGKILL 后 pid " + pid + " 仍未退出——不报告成功\n" +
        "  下一步：人工处理（kill -9 " + pid + " / 检查 zombie），随后 dsh-web status 复核");
      await finishStop(deps, st, { ...opts, sheet: false }); // 附终验信息，不重复附表
      if (opts.sheet !== false) out(renderCheatsheet());
      return 1;
    }
  }
  out("✅ DSH 已停止（pid " + pid + "）");
  reapChildren(deps, st);
  await waitChildrenGone(deps, st);
  return finishStop(deps, st, opts);
}
async function cmdRestart(deps, st) {
  // 内部步骤不各自附表，外层统一附一次
  const code = await cmdStop(deps, st, { sheet: false });
  if (code !== 0) { deps.out(renderCheatsheet()); return code; }
  deps.out("↻ 重新启动…");
  const st2 = await detectState(deps);
  const code2 = await cmdStart(deps, st2, { sheet: false });
  deps.out(renderCheatsheet());
  return code2;
}

async function cmdStatus(deps, st) {
  const out = deps.out;
  const lines = ["dsh-web status", ""];
  if (st.state === "not-installed") {
    lines.push("✗ 插件未安装 → " + gateMessages(st)["not-installed"].split("\n").slice(1).join(" ").trim());
  } else {
    lines.push("✅ 插件已安装：" + st.pluginDir);
    lines.push(st.entry?.enabled
      ? "✅ 插件 entry enabled（装载开，命令应可用）"
      : "✗ 插件 entry enabled=false（未打开）→ " + gateMessages(st).disabled.split("\n").slice(1).join(" ").trim());
  }
  const own = portOwner(deps, DSH_PORT);
  if (own.state === "error") {
    lines.push("⚠ 无法确认端口 " + DSH_PORT + " 的属主（lsof 不可用）");
  } else if (own.state === "found") {
    const args = procArgs(deps, own.pid);
    lines.push(isDshProcess(deps, args)
      ? "✅ DSH 进程在跑：pid " + own.pid + "（端口 " + DSH_PORT + "）"
      : "⚠ 端口 " + DSH_PORT + " 被非 DSH 进程占用：pid " + own.pid + " → " + (args || "（未知命令行）"));
  } else {
    lines.push("✗ DSH 未运行（端口 " + DSH_PORT + " 无监听）→ 跑 dsh-web 后台拉起");
  }
  if (st.apiState) {
    lines.push(st.apiState.running
      ? "✅ 隧道运行中：" + st.apiState.url
      : "✗ 隧道未开启 → dsh-web start（或在插件页点启动）");
    lines.push("📨 通知通道：" + (st.apiState.channel || "off"));
  } else {
    lines.push("ℹ 插件 API（127.0.0.1:9091）不可达——DSH 未运行或插件未装载");
  }
  const job2 = launchdDshJob(deps);
  const plist = agentPlist(deps);
  lines.push(job2.exists && job2.running
    ? "✅ 开机自启 agent：已装载并在运行（com.deepseek.dsh-web）"
    : job2.exists
      ? "⚠ 开机自启 agent：已装载但未运行"
      : deps.existsSync(plist)
        ? "ℹ 开机自启 agent：已安装未装载（上次 dsh-web stop 卸载；跑 dsh-web 会自动重新装载）"
        : "ℹ 开机自启 agent：未安装（可选，不影响手动 dsh-web）");
  out(lines.join("\n") + renderCheatsheet());
  return 0;
}

async function cmdUrl(deps, st) {
  if (st.state === "dsh-down") {
    deps.err("✗ DSH 没在跑，拿不到 URL\n  下一步：跑 dsh-web 后台拉起，稍后再看 dsh-web url");
    deps.out(renderCheatsheet());
    return 1;
  }
  if (!st.apiState?.url) {
    deps.err("✗ 隧道还没拿到 URL（可能没开或还在建立）\n  下一步：跑 dsh-web start；若持续拿不到 → dsh-web logs cloudflared");
    deps.out(renderCheatsheet());
    return 1;
  }
  deps.out(st.apiState.url + renderCheatsheet());
  return 0;
}

async function cmdPassword(deps, st) {
  try {
    const { password } = await apiCall(deps, "/rc-api/reveal", { method: "POST" });
    deps.out("🔑 访问密码：" + password + renderCheatsheet());
    return 0;
  } catch (e) {
    deps.err("✗ 密码获取失败：" + e.message + "\n" +
      "  下一步：在插件详情页查看（Plugins → Nano Market → dsh-remote → 配置）；或确认 DSH 在跑（dsh-web status）");
    deps.out(renderCheatsheet());
    return 1;
  }
}

async function cmdLogs(deps, st, which) {
  const target = which || "cloudflared";
  const files = [];
  if (target === "dsh") {
    files.push(path.join(st.dshLogDir, "dsh-web.cli.out.log"), path.join(st.dshLogDir, "dsh-web.cli.err.log"));
  } else if (target === "cloudflared" || target === "caddy" || target === "access") {
    files.push(path.join(st.runDir, target + ".log"));
  } else {
    deps.err("✗ logs 参数只支持 caddy | cloudflared | access | dsh（缺省 cloudflared）");
    deps.out(renderCheatsheet());
    return 1;
  }
  for (const f of files) {
    deps.out("──── " + f + "（尾部 " + deps.tailLines + " 行）");
    let text = "";
    try { text = String(deps.readFileSync(f, "utf8")); } catch { deps.out("（日志文件不存在）"); continue; }
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const l of lines.slice(-deps.tailLines)) deps.out(l);
  }
  deps.out(renderCheatsheet());
  return 0;
}

// ---------- 入口 ----------

export async function runCommand(argv, deps = createDeps()) {
  const cmd = String(argv[0] ?? "start").toLowerCase();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    deps.out(renderCheatsheet());
    return 0;
  }
  if (!["start", "stop", "restart", "status", "url", "password", "logs"].includes(cmd)) {
    deps.err("✗ 未知命令：dsh-web " + cmd + "（裸 dsh-web 即启动）");
    deps.out(renderCheatsheet());
    return 1;
  }
  const st = await detectState(deps);
  if (cmd === "status") return cmdStatus(deps, st); // status 不被闸门打断：报告现状本身
  if (st.state === "not-installed" || st.state === "disabled") {
    deps.err(gateMessages(st)[st.state]);
    deps.out(renderCheatsheet());
    return 1; // 闸门拒绝：不产生任何副作用进程
  }
  switch (cmd) {
    case "start": return cmdStart(deps, st);
    case "stop": return cmdStop(deps, st);
    case "restart": return cmdRestart(deps, st);
    case "url": return cmdUrl(deps, st);
    case "password": return cmdPassword(deps, st);
    case "logs": return cmdLogs(deps, st, argv[1]);
    default: return 1;
  }
}

function invokedDirectly() {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    if (pathToFileURL(arg1).href === import.meta.url) return true;
    return fs.realpathSync(arg1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

export async function main() {
  const deps = createDeps();
  process.exitCode = await runCommand(process.argv.slice(2), deps);
}

if (invokedDirectly()) await main();
