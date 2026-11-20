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

// ---------- 命令速查表（每条命令执行完都追加；help 只打印它） ----------

export const COMMANDS = [
  { cmd: "dsh-web", desc: "启动：后台拉起 DSH（终端可关）+ 开隧道，打印访问地址与密码（幂等）" },
  { cmd: "dsh-web help", desc: "只看这张命令速查表" },
  { cmd: "dsh-web stop", desc: "停隧道（本机 API）+ 停 DSH 进程（按 3080 端口属主核对后终止）" },
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
    mkdirSync: overrides.mkdirSync ?? ((p, o) => fs.mkdirSync(p, o)),
    openSync: overrides.openSync ?? ((p, f) => fs.openSync(p, f)),
    closeSync: overrides.closeSync ?? ((fd) => fs.closeSync(fd)),
    fetch: overrides.fetch ?? fetch,
    spawn: overrides.spawn ?? nodeSpawn, // spawn 原语可注入：单测据此验证 detached 契约
    spawnSync: overrides.spawnSync ?? nodeSpawnSync,
    kill: overrides.kill ?? ((pid, sig) => process.kill(pid, sig)),
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: overrides.now ?? (() => Date.now()), // 单调时钟可注入：poll 用真实 deadline 而非累计 sleep
    out,
    err: overrides.err ?? ((s) => process.stderr.write(s + "\n")),
    apiTimeoutMs: overrides.apiTimeoutMs ?? 4000,
    startWaitMs: overrides.startWaitMs ?? 90_000, // DSH 冷启动就绪超时
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
  return { state: "none", pid: 0 }; // lsof 无匹配时以非零码退出 = 无监听
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

function isDshProcess(args) {
  const parts = String(args).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  let entry = parts[0];
  let rest = parts.slice(1);
  if (INTERPRETERS.has(entry.split("/").pop().toLowerCase()) && rest.length > 0) {
    entry = rest[0];
    rest = rest.slice(1);
  }
  const base = entry.split("/").pop();
  const isDshBin = base === "dsh" || entry.includes("@deepseek-ai/dsh");
  if (!isDshBin) return false;
  return rest.length === 0 || rest.includes("web");
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

// 兜底回收后仍存活的插件子进程（stop 终验用）
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
async function pollUntil(deps, budgetMs, tryOnce) {
  const deadline = deps.now() + budgetMs;
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(deps.startPollStepMs, Math.max(0, deadline - deps.now())));
    const left = Math.max(250, deadline - deps.now());
    try {
      const hit = await tryOnce(left);
      if (hit) return true;
    } catch { /* 瞬断重试 */ }
  }
  return false;
}

async function cmdStart(deps, st, opts = {}) {
  const out = deps.out, err = deps.err;
  const sheet = () => { if (opts.sheet !== false) out(renderCheatsheet()); };
  let apiState = st.state === "ready" ? st.apiState : null;
  if (st.state === "dsh-down") {
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
    const ok = await pollUntil(deps, deps.startWaitMs, async (budget) => {
      apiState = await apiCall(deps, "/rc-api/state", { timeoutMs: budget });
      return true; // API 一通即视为就绪（装载与隧道状态在后续阶段判断）
    });
    if (!ok || !apiState) {
      err("✗ 等待 DSH 就绪超时（" + deps.startWaitMs / 1000 + "s）——插件 API（127.0.0.1:9091）没有应答\n" +
        "  下一步：dsh-web logs dsh 看启动日志；或前台跑 dsh web 看真实报错");
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
  const waited = await pollUntil(deps, deps.urlWaitMs, async (budget) => {
    apiState = await apiCall(deps, "/rc-api/state", { timeoutMs: budget });
    return !!apiState.url;
  });
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
  const sheet = () => { if (opts.sheet !== false) out(renderCheatsheet()); };
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
  const own = portOwner(deps, DSH_PORT);
  if (own.state === "error") {
    err("✗ 无法确认端口 " + DSH_PORT + " 的属主（lsof 不可用？）——为避免误杀，本次不终止任何进程\n" +
      "  下一步：手动 lsof -nP -iTCP:" + DSH_PORT + " -sTCP:LISTEN 确认后处理");
    reapChildren(deps, st); // 隧道兜底照做
    sheet();
    return 1;
  }
  if (own.state === "none") {
    out("✅ 端口 " + DSH_PORT + " 无监听——DSH 未在运行");
    reapChildren(deps, st);
    if (!tunnelConfirmed) {
      err("⚠ 隧道停用请求失败且 DSH 已不在——caddy/cloudflared 可能残留，上面兜底回收的结果请人工确认");
      sheet();
      return 1;
    }
    sheet();
    return 0;
  }
  const pid = own.pid;
  const args = procArgs(deps, pid);
  if (!isDshProcess(args)) {
    err("✗ 端口 " + DSH_PORT + " 的属主不是 DSH，拒绝终止：pid " + pid + " → " + (args || "（未知命令行）") + "\n" +
      "  下一步：确认该进程是什么；若确属 DSH 残留，手动处理后再跑 dsh-web stop");
    sheet();
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
    if (!isDshProcess(args2)) {
      err("✗ pid " + pid + " 在等待退出期间易主（现为：" + (args2 || "?") + "）——不升级 SIGKILL\n" +
        "  下一步：人工确认 pid " + pid + " 现属谁；DSH 若换 pid 重现，再跑 dsh-web stop");
      reapChildren(deps, st);
      sheet();
      return 1;
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
      sheet();
      return 1;
    }
  }
  out("✅ DSH 已停止（pid " + pid + "）");
  reapChildren(deps, st);
  // 终验：DSH 端口已释放 + 兜底回收的子进程确实不在——不干净就不报成功
  const leftovers = [];
  const own2 = portOwner(deps, DSH_PORT);
  if (own2.state === "found") leftovers.push("端口 " + DSH_PORT + " 仍有监听（pid " + own2.pid + " → " + procArgs(deps, own2.pid) + "）");
  const survivors = survivingChildren(deps, st);
  leftovers.push(...survivors.map((s) => s + " 仍在运行"));
  if (leftovers.length > 0) {
    err("✗ stop 未清理干净：" + leftovers.join("；") + "\n" +
      "  下一步：按上面的 pid 逐个确认（可能是 PID 复用或外部拉起），处理后再 dsh-web status 复核");
    sheet();
    return 1;
  }
  sheet();
  return 0;
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
    lines.push(isDshProcess(args)
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
  const plist = path.join(st.home, "Library", "LaunchAgents", "com.deepseek.dsh-web.plist");
  lines.push(deps.existsSync(plist)
    ? "✅ 开机自启 agent：已安装（" + plist + "）"
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
