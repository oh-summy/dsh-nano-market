// dsh-web CLI tests — 三态探测 / detached 契约 / 速查表 / 闸门无副作用。
// 全部走注入 deps（memfs + 假 fetch/spawn），不打真机、不起真进程。
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

// 造一个全注入的世界：文件在 Map 里、fetch/spawn/spawnSync 全是记录器
function makeWorld(opts = {}) {
  const files = new Map(Object.entries(opts.files || {}));
  const dirs = new Set(opts.dirs === undefined ? [PLUGIN_DIR] : opts.dirs);
  const log = { spawn: [], unref: 0, spawnSync: [], fetch: [], kills: [] };
  const outLines = [], errLines = [];

  const deps = createDeps({
    homedir: () => HOME,
    env: {},
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) { const e = new Error("ENOENT " + p); e.code = "ENOENT"; throw e; }
      return files.get(p);
    },
    mkdirSync: () => {},
    openSync: () => 11,
    closeSync: () => {},
    fetch: async (url, o) => {
      log.fetch.push({ url, method: (o && o.method) || "GET" });
      if (!opts.fetch) { const e = new Error("ECONNREFUSED"); e.cause = e; throw e; }
      return opts.fetch(url, o, log.fetch.length);
    },
    spawn: (cmd, args, o) => { log.spawn.push({ cmd, args, o }); log.unref++; return { unref() {} }; },
    spawnSync: (cmd, args) => {
      log.spawnSync.push({ cmd, args });
      if (opts.spawnSync) return opts.spawnSync(cmd, args, log.spawnSync.length);
      if (cmd === "which") return { status: 0, stdout: "/usr/local/bin/dsh\n" };
      return { status: 1, stdout: "" };
    },
    kill: (pid, sig) => log.kills.push({ pid, sig }),
    sleep: async () => {},
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
  });
  return { deps, log, outLines, errLines };
}

const STATE = (over = {}) => ({ running: true, url: "https://demo-try.trycloudflare.com", channel: "dm", ...over });

test("cheatsheet 列出全部 8 条命令", () => {
  const sheet = renderCheatsheet();
  assert.equal(COMMANDS.length, 8);
  for (const c of COMMANDS) assert.ok(sheet.includes(c.cmd), "缺命令：" + c.cmd);
  assert.ok(sheet.includes("dsh-web help") && sheet.includes("dsh-web logs"));
});

test("help 只打印速查表，不访问 API", async () => {
  const w = makeWorld();
  const code = await runCommand(["help"], w.deps);
  assert.equal(code, 0);
  const text = w.outLines.join("\n");
  for (const c of COMMANDS) assert.ok(text.includes(c.cmd));
  assert.equal(w.log.fetch.length, 0);
});

test("三态①未安装：明确报错 + 指引安装命令 + 无任何副作用进程", async () => {
  const w = makeWorld({ dirs: [] }); // 插件包不存在
  const code = await runCommand([], w.deps); // 裸 dsh-web = start
  assert.equal(code, 1);
  const text = w.errLines.join("\n");
  assert.ok(text.includes("插件未安装"));
  assert.ok(text.includes("dsh plugin --profile web add @oh-summy/dsh-remote"));
  assert.ok(w.outLines.join("\n").includes("命令速查表")); // 错误也附速查表
  assert.equal(w.log.spawn.length, 0, "不得拉起任何进程");
  assert.equal(w.log.spawnSync.length, 0);
  assert.equal(w.log.fetch.length, 0, "不得访问 API");
});

test("三态②未打开（entry enabled=false）：明确报错 + 指引开关 + 无任何副作用进程", async () => {
  const w = makeWorld({ files: { [PATCH_FILE]: PATCH_DISABLED } });
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  const text = w.errLines.join("\n");
  assert.ok(text.includes("插件未打开"));
  assert.ok(text.includes("enabled"));
  assert.ok(text.includes("Plugins → Nano Market → dsh-remote"));
  assert.equal(w.log.spawn.length, 0, "不得拉起任何进程");
  assert.equal(w.log.spawnSync.length, 0);
  assert.equal(w.log.fetch.length, 0, "不得访问 API");
});

test("三态②补：patch 文件缺失也按「未打开」处理", async () => {
  const w = makeWorld({ files: {} }); // pluginDir 在（dirs 默认），patch 缺失
  const code = await runCommand([], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("插件未打开"));
  assert.equal(w.log.spawn.length, 0);
});

test("三态③已打开 + DSH 没跑：detached 后台拉起 + URL + 密码 + 速查表", async () => {
  let apiCalls = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o, n) => {
      if (url.endsWith("/rc-api/state")) {
        apiCalls++;
        if (n === 1) throw new Error("ECONNREFUSED"); // 探测时 API 不通 = DSH 没跑
        return new Response(JSON.stringify(STATE()), { status: 200 });
      }
      if (url.endsWith("/rc-api/reveal")) return new Response(JSON.stringify({ password: "pw-demo" }), { status: 200 });
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
  assert.equal(w.log.unref, 1, "必须 unref");
  const text = w.outLines.join("\n");
  assert.ok(text.includes("https://demo-try.trycloudflare.com"));
  assert.ok(text.includes("pw-demo"));
  assert.ok(text.includes("命令速查表"));
});

test("三态③幂等：DSH 已在跑 → 不再拉起第二个实例，只打印 URL + 密码", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o) => {
      if (url.endsWith("/rc-api/state")) return new Response(JSON.stringify(STATE()), { status: 200 });
      if (url.endsWith("/rc-api/reveal")) return new Response(JSON.stringify({ password: "pw-demo" }), { status: 200 });
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 0);
  assert.equal(w.log.spawn.length, 0, "幂等：不得重复拉起");
  const text = w.outLines.join("\n");
  assert.ok(text.includes("https://demo-try.trycloudflare.com"));
  assert.ok(text.includes("pw-demo"));
  assert.ok(text.includes("命令速查表"));
});

test("start：隧道运行时开关没开 → 经 API toggle 打开（两个开关不混）", async () => {
  let toggles = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o) => {
      if (url.endsWith("/rc-api/state")) {
        // toggle 之前 running=false 且无 URL；toggle 之后就绪
        const afterToggle = toggles > 0;
        return new Response(JSON.stringify(STATE(afterToggle ? {} : { running: false, url: "" })), { status: 200 });
      }
      if (url.endsWith("/rc-api/toggle")) { toggles++; return new Response(JSON.stringify({ ok: true, enabled: true }), { status: 200 }); }
      if (url.endsWith("/rc-api/reveal")) return new Response(JSON.stringify({ password: "pw-demo" }), { status: 200 });
      throw new Error("unexpected " + url);
    },
  });
  const code = await runCommand([], w.deps);
  assert.equal(code, 0);
  assert.equal(toggles, 1, "恰好 toggle 一次");
  assert.equal(w.log.spawn.length, 0);
  assert.ok(w.outLines.join("\n").includes("https://demo-try.trycloudflare.com"));
});

test("stop：3080 属主不是 DSH → 拒绝终止，不 kill", async () => {
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url) => {
      if (url.endsWith("/rc-api/state")) return new Response(JSON.stringify(STATE({ running: false })), { status: 200 });
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") return { status: 0, stdout: "999\n" };
      if (cmd === "ps" && args.includes("args=")) return { status: 0, stdout: "some-other-app --port 3080\n" };
      return { status: 1, stdout: "" };
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 1);
  assert.ok(w.errLines.join("\n").includes("拒绝终止"));
  assert.equal(w.log.kills.length, 0, "不得误杀非 DSH 进程");
});

test("stop：3080 属主是 DSH → 先停隧道再 SIGTERM", async () => {
  let toggles = 0;
  const w = makeWorld({
    files: { [PATCH_FILE]: PATCH_ENABLED },
    fetch: async (url, o) => {
      if (url.endsWith("/rc-api/state")) return new Response(JSON.stringify(STATE(), { status: 200 }));
      if (url.endsWith("/rc-api/toggle")) { toggles++; return new Response(JSON.stringify({ ok: true, enabled: false }), { status: 200 }); }
      throw new Error("unexpected " + url);
    },
    spawnSync: (cmd, args) => {
      if (cmd === "lsof") return { status: 0, stdout: "42\n" };
      if (cmd === "ps" && args.includes("args=")) return { status: 0, stdout: "/usr/local/bin/dsh web --no-open\n" };
      if (cmd === "ps" && args.length === 2) return { status: 1, stdout: "" }; // 进程已不在
      return { status: 1, stdout: "" };
    },
  });
  const code = await runCommand(["stop"], w.deps);
  assert.equal(code, 0);
  assert.equal(toggles, 1, "先经 API 停隧道");
  assert.deepEqual(w.log.kills, [{ pid: 42, sig: "SIGTERM" }]);
});

test("readPatchEntry：entry 级 enabled 优先于 config 级；config 级兜底；缺失=false", () => {
  const w = makeWorld();
  // config 级（≥4 空格缩进）
  const cfg = readPatchEntry(w.deps, PATCH_FILE.replace(PATCH_FILE, "/nonexistent.yml"));
  assert.equal(cfg.enabled, false);
  const files = new Map([[PATCH_FILE, PATCH_ENABLED]]);
  const deps = createDeps({ readFileSync: (p) => files.get(p), existsSync: () => false, homedir: () => HOME, env: {} });
  assert.equal(readPatchEntry(deps, PATCH_FILE).enabled, true);
  const files2 = new Map([[PATCH_FILE, "- id: dsh-remote\n  enabled: true\n  config:\n    enabled: false\n"]]);
  const deps2 = createDeps({ readFileSync: (p) => files2.get(p), existsSync: () => false, homedir: () => HOME, env: {} });
  const e = readPatchEntry(deps2, PATCH_FILE);
  assert.equal(e.enabled, true, "entry 级优先");
  const files3 = new Map([[PATCH_FILE, "- id: dsh-remote\n  name: x\n"]]);
  const deps3 = createDeps({ readFileSync: (p) => files3.get(p), existsSync: () => false, homedir: () => HOME, env: {} });
  assert.equal(readPatchEntry(deps3, PATCH_FILE).enabled, false, "enabled 键缺失 = 未打开");
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
    fetch: async (url) => new Response(JSON.stringify(STATE()), { status: 200 }),
  });
  const st = await detectState(up.deps);
  assert.equal(st.state, "ready");
  assert.equal(st.apiState.url, "https://demo-try.trycloudflare.com");
});
