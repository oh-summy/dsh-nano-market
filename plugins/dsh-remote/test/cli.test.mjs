// dsh-web CLI tests — 三态探测 / detached 契约 / 速查表 / 闸门无副作用 / stop 清理可靠性。
// 全部走注入 deps（memfs + 假 fetch/spawn/时钟），不打真机、不起真进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { COMMANDS, createDeps, detectState, readPatchEntry, renderCheatsheet, runCommand } from "../bin/dsh-web.mjs";

const HOME = "/h";
const PATCH_FILE = join(HOME, ".dsh", "profiles", "web", "cordis.patch.yml");
const PLUGIN_DIR = join(HOME, ".dsh", "profiles", "web", "node_modules", "@oh-summy", "dsh-remote");

const PATCH_ENABLED = [
  "- id: dsh-remote",
  '  name: "@oh-summy/dsh-remote"',
  "  config:",
  "    enabled: true",
  "- id: connect-lark",
  '  name: "@oh-summy/connect-lark"',
  "  config:",
  "    appId: cli_xxx",
].join("\n");

const PATCH_DISABLED = [
  "- id: dsh-remote",
  '  name: "@oh-summy/dsh-remote"',
  "  config:",
  "    enabled: false",
].join("\n");

const URL = "https://demo-try.trycloudflare.com";
const STATE = (over = {}) => ({ running: true, url: URL, channel: "dm", ...over });

// 造一个全注入的世界：文件在 Map 里、fetch/spawn/spawnSync/时钟全是记录器。
// unref 计数必须在 fake 的 unref() 里加——否则删掉实现里的 child.unref() 测试照样绿（假阳性）。
function makeWorld(opts = {}) {
  const files = new Map(Object.entries(opts.files || {}));
  const dirs = new Set(opts.dirs === undefined ? [PLUGIN_DIR] : opts.dirs);
  const log = { spawn: [], unref: 0, spawnSync: [], fetch: [], kills: [], mkdirs: [], opens: [] };
  const outLines = [], errLines = [];
  let clock = 0;

  const deps = createDeps({
    homedir: () => HOME,
    env: {},
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error("ENOENT " + p); e.code = "ENOENT"; throw e; }
      return files.get(p);
    },
    mkdirSync: (p) => { log.mkdirs.push(p); },
    openSync: (p) => { log.opens.push(p); return 11; },
    closeSync: () => {},
    fetch: async (url, o) => {
      log.fetch.push({ url, method: (o && o.method) || "GET" });
      if (!opts.fetch) throw new Error("ECONNREFUSED"); // 默认 = 插件 API 不通
      return opts.fetch(url, o || {}, log.fetch.length);
    },
    spawn: (cmd, args, o) => {
      log.spawn.push({ cmd, args, o });
      return { unref() { log.unref++; }, on() {} };
    },
    spawnSync: (cmd, args) => {
      log.spawnSync.push({ cmd, args });
      if (opts.spawnSync) return opts.spawnSync(cmd, args, log.spawnSync.length);
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      return { status: 1, stdout: "" };
    },
    kill: (pid, sig) => log.kills.push({ pid, sig }),
    sleep: async (ms) => { clock += ms; }, // 注入时钟随 sleep 前进：poll 的 deadline 语义真实可测
    now: () => clock,
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
  });
  return { deps, log, outLines, errLines };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("cheatsheet 列出全部 8 条命令", () => {
  const sheet = renderCheatsheet();
  assert.equal(COMMANDS.length, 8);
  for (const c of COMMANDS) assert.ok(sheet.includes(c.cmd), "缺命令：" + c.cmd);
});

test("help 只打印速查表，不访问 API", async () => {
  const w = makeWorld();
  const code = await runCommand(["help"], w.deps);
  assert.equal(code, 0);
  const text = w.outLines.join("\n");
  for (const c of COMMANDS) assert.ok(text.includes(c.cmd));
  assert.equal(w.log.fetch.length, 0);
});

test("三态①未安装：全部受保护命令报错 + 指引 + 零副作用（无进程/无请求/无文件）", async () => {
  for (const argv of [[], ["stop"], ["restart"], ["url"], ["password"], ["logs"]]) {
    const w = makeWorld({ dirs: [] }); // 插件包不存在
    const code = await runCommand(argv, w.deps);
    assert.equal(code, 1, "argv=" + JSON.stringify(argv));
    assert.ok(w.errLines.join("\n").includes("插件未安装"), "argv=" + JSON.stringify(argv));
    assert.ok(w.errLines.join("\n").includes("dsh plugin --profile web add @oh-summy/dsh-remote"));
    assert.ok(w.outLines.join("\n").includes("命令速查表"), "错误也附速查表");
    assert.equal(w.log.spawn.length, 0, "不得拉起任何进程");
    assert.equal(w.log.spawnSync.length, 0);
    assert.equal(w.log.fetch.length, 0, "不得访问 API");
    assert.equal(w.log.mkdirs.length, 0, "不得写文件系统");
    assert.equal(w.log.opens.length, 0);
    assert.equal(w.log.kills.length, 0);
  }
});

test("三态②未打开（entry enabled=false）：全部受保护命令报错 + 零副作用", async () => {
  for (const argv of [[], ["stop"], ["restart"], ["url"], ["password"], ["logs"]]) {
    const w = makeWorld({ files: { [PATCH_FILE]: PATCH_DISABLED } });
    const code = await runCommand(argv, w.deps);
    assert.equal(code, 1, "argv=" + JSON.stringify(argv));
    const text = w.errLines.join("\n");
    assert.ok(text.includes("插件未打开"), "argv=" + JSON.stringify(argv));
    assert.ok(text.includes("enabled"));
    assert.ok(text.includes("Plugins → Nano Market → dsh-remote"));
    assert.equal(w.log.spawn.length, 0);
    assert.equal(w.log.spawnSync.length, 0);
    assert.equal(w.log.fetch.length, 0);
    assert.equal(w.log.mkdirs.length, 0);
    assert.equal(w.log.opens.length, 0);
    assert.equal(w.log.kills.length, 0);
  }
});

test("三态②补：patch 文件缺失也按「未打开」处理", async () => {
  const w = makeWorld({ files: {} });
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("插件未打开"));
  assert.equal(w.log.spawn.length, 0);
});

test("三态③已打开 + DSH 没跑：detached 后台拉起 + URL + 密码 + 速查表", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o, n) => {
      if (url.endsWith("/rc-api/state")) return n === 1 ? Promise.reject(new Error("ECONNREFUSED")) : jsonResponse(STATE()); // 第 1 次=探测（不通），拉起后的轮询通
      if (url.endsWith("/rc-api/reveal")) return jsonResponse({ password: "pw-demo" });
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 0);
  assert.equal(w.log.spawn.length, 1, "恰好拉起一个 DSH 实例");
  const s = w.log.spawn[0];
  assert.equal(s.cmd, "/usr/local/bin/dsh");
  assert.deepEqual(s.args, ["web", "--no-open"]);
  assert.equal(s.o.detached, true, "必须 detached（终端可关）");
  assert.equal(s.o.stdio[0], "ignore");
  assert.equal(w.log.unref, 1, "必须 unref（计数在 fake 的 unref() 内）");
  const text = w.outLines.join("\n");
  assert.ok(text.includes(URL));
  assert.ok(text.includes("pw-demo"));
  assert.ok(text.includes("命令速查表"));
});

test("start 幂等：DSH 已在跑 → 不再拉起第二个实例，只打印 URL + 密码", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE());
      if (url.endsWith("/rc-api/reveal")) return jsonResponse({ password: "pw-demo" });
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 0);
  assert.equal(w.log.spawn.length, 0, "幂等：不得重复拉起");
  const text = w.outLines.join("\n");
  assert.ok(text.includes(URL));
  assert.ok(text.includes("pw-demo"));
});

test("P0-1 回归：running=true 但 URL 未捕获 → 继续等待，拿到 URL 才算成功", async () => {
  let stateCalls = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o, n) => {
      if (url.endsWith("/rc-api/state")) {
        stateCalls++;
        // 第 1 次 = 探测（不通）；拉起后前 2 次 = running 但 URL 还没从日志捕获
        if (n === 1) throw new Error("ECONNREFUSED");
        if (stateCalls <= 3) return jsonResponse(STATE({ url: "" }));
        return jsonResponse(STATE());
      }
      if (url.endsWith("/rc-api/reveal")) return jsonResponse({ password: "pw-demo" });
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 0);
  assert.equal(w.log.spawn.length, 1);
  assert.equal(w.log.fetch.filter((f) => f.url.endsWith("/rc-api/toggle")).length, 0, "隧道已在跑，不 toggle");
  assert.ok(w.outLines.join("\n").includes(URL), "必须打印非空 URL");
});

test("P0-1 回归：running=true 且 URL 始终未出现 → 超时报错，退出非零，不打印空入口", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o, n) => {
      if (url.endsWith("/rc-api/state")) return n === 1 ? Promise.reject(new Error("ECONNREFUSED")) : jsonResponse(STATE({ url: "" }));
      throw new Error("unexpected " + url); // reveal 不应被调用
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("没拿到隧道 URL"));
  assert.ok(!w.outLines.join("\n").includes("🌐 公网入口："), "不得打印空 URL 成功输出");
  assert.equal(w.log.fetch.filter((f) => f.url.endsWith("/rc-api/reveal")).length, 0);
});

test("start：隧道没开 → 经 API toggle 打开（两个开关不混）", async () => {
  let toggles = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o) => {
      if (url.endsWith("/rc-api/state")) {
        const afterToggle = toggles > 0;
        return jsonResponse(STATE(afterToggle ? {} : { running: false, url: "" }));
      }
      if (url.endsWith("/rc-api/toggle")) { toggles++; return jsonResponse({ ok: true, enabled: true }); }
      if (url.endsWith("/rc-api/reveal")) return jsonResponse({ password: "pw-demo" });
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 0);
  assert.equal(toggles, 1, "恰好 toggle 一次");
  assert.equal(w.log.spawn.length, 0);
  assert.ok(w.outLines.join("\n").includes(URL));
});

test("start：toggle 失败 → 报错 + 下一步指引，退出非零", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o, n) => {
      if (url.endsWith("/rc-api/state")) return n === 1 ? Promise.reject(new Error("ECONNREFUSED")) : jsonResponse(STATE({ running: false, url: "" }));
      if (url.endsWith("/rc-api/toggle")) return jsonResponse({ error: "boom" }, 500);
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("打开隧道失败"));
});

test("P1-3 回归：reveal 失败 → start 返回非零（URL+密码齐才算成功）", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE());
      if (url.endsWith("/rc-api/reveal")) return jsonResponse({}, 500);
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("密码获取失败"));
});

test("start：DSH 一直起不来 → 超时报错 + 指引，退出非零", async () => {
  const w = makeWorld({ files: { [PATCH_FILE]: PATCH_ENABLED } }); // fetch 默认一直拒绝
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("等待 DSH 就绪超时"));
  assert.ok(w.errLines.join("\n").includes("dsh web"));
});

// ---------- stop ----------

// 真 DSH 的 ps args 形态（本机实测）：解释器在第一位，入口是第二个 token
const DSH_ARGS = "node /Users/rocky/.npm-global/bin/dsh web";

test("P0-2 回归：3080 属主命令行含 dsh 字样但入口不是 dsh → 拒绝终止，不 kill", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE({ running: false }));
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") return { status: 0, stdout: "999\n" };
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      if (cmd === "ps" && args.includes("args=")) return { status: 0, stdout: "python worker.py dsh --port 3080\n" };
      return { status: 1, stdout: "" };
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("拒绝终止"));
  assert.equal(w.log.kills.length, 0, "不得误杀非 DSH 进程");
});

test("stop：3080 属主是 DSH（node 入口形态）→ 先停隧道再 SIGTERM，终验通过", async () => {
  let toggles = 0;
  let lsofCalls = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE());
      if (url.endsWith("/rc-api/toggle")) { toggles++; return jsonResponse({ ok: true, enabled: false }); }
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") { lsofCalls++; return lsofCalls === 1 ? { status: 0, stdout: "42\n" } : { status: 1, stdout: "" }; }
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      if (cmd === "ps" && args.includes("args=")) return { status: 0, stdout: DSH_ARGS + "\n" };
      return { status: 1, stdout: "" }; // 进程已不在
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 0);
  assert.equal(toggles, 1, "先经 API 停隧道");
  assert.deepEqual(w.log.kills, [{ pid: 42, sig: "SIGTERM" }]);
});

test("P0-2 回归：SIGKILL 升级前 PID 复用 → 不升级，不误杀", async () => {
  let argsCalls = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE({ running: false }));
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") return { status: 0, stdout: "42\n" };
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      if (cmd === "ps" && args.includes("args=")) {
        argsCalls++;
        return argsCalls === 1 ? { status: 0, stdout: DSH_ARGS + "\n" } : { status: 0, stdout: "evil-proc --took-over\n" };
      }
      return { status: 0, stdout: "  PID TTY\n   42 ?\n" }; // 一直活着
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 1);
  assert.deepEqual(w.log.kills, [{ pid: 42, sig: "SIGTERM" }], "只 SIGTERM，不升级 SIGKILL");
  assert.ok(w.errLines.join("\n").includes("易主"));
});

test("P1-1 回归：SIGKILL 后仍未退出 → 不报告成功，退出非零", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE({ running: false }));
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") return { status: 0, stdout: "42\n" };
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      if (cmd === "ps" && args.includes("args=")) return { status: 0, stdout: DSH_ARGS + "\n" };
      return { status: 0, stdout: "  PID TTY\n   42 ?\n" }; // 打不死
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("仍未退出"));
  assert.deepEqual(w.log.kills, [{ pid: 42, sig: "SIGTERM" }, { pid: 42, sig: "SIGKILL" }]);
});

test("P1-1 回归：lsof 不可用 = 侦察失败 → 不终止任何进程，退出非零", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE({ running: false }));
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd) => {
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      if (cmd === "lsof") return { error: new Error("ENOENT"), status: null, stdout: "" };
      return { status: 1, stdout: "" };
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("无法确认端口"));
  assert.equal(w.log.kills.length, 0);
});

test("stop：DSH 本来就没在跑 → 直接成功并兜底回收", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return jsonResponse(STATE({ running: false }));
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") return { status: 1, stdout: "" }; // 无监听
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      return { status: 1, stdout: "" };
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 0);
  assert.equal(w.log.kills.length, 0);
  assert.ok(w.outLines.join("\n").includes("DSH 未在运行"));
});

test("readPatchEntry：entry 级 enabled 优先于 config 级；config 级兜底；缺失=false", () => {
  const mk = (text) => createDeps({
    readFileSync: (p) => {
      if (p !== PATCH_FILE || text === null) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return text;
    },
    existsSync: () => false, homedir: () => HOME, env: {},
  });
  assert.equal(readPatchEntry(mk(null), PATCH_FILE).enabled, false, "文件不存在 = 未打开");
  assert.equal(readPatchEntry(mk(PATCH_ENABLED), PATCH_FILE).enabled, true, "config 级兜底");
  const entryLevel = readPatchEntry(mk("- id: dsh-remote\n  enabled: true\n  config:\n    enabled: false\n"), PATCH_FILE);
  assert.equal(entryLevel.enabled, true, "entry 级优先");
  assert.equal(readPatchEntry(mk("- id: dsh-remote\n  name: x\n"), PATCH_FILE).enabled, false, "enabled 键缺失 = 未打开");
});

test("detectState：三态返回值与探测顺序（包 → enabled → API）", async () => {
  const off = makeWorld({ dirs: [] });
  assert.equal((await detectState(off.deps)).state, "not-installed");
  const dis = makeWorld({ files: { [PATCH_FILE]: PATCH_DISABLED } });
  assert.equal((await detectState(dis.deps)).state, "disabled");
  const down = makeWorld({ files: { [PATCH_FILE]: PATCH_ENABLED } }); // fetch 默认拒绝 = API 不通
  assert.equal((await detectState(down.deps)).state, "dsh-down");
  const up = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => jsonResponse(STATE()),
  });
  const st = await detectState(up.deps);
  assert.equal(st.state, "ready");
  assert.equal(st.apiState.url, URL);
});
