// 渲染探针（审查三轮 P0/P1-3 要求）：执行真实客户端源码 + 微 hooks shim + 非空快照。
// 一轮审查的 P0（freshConfirmed ReferenceError）只有这类测试能抓到——纯函数/正则测试全绿是假象。
// 覆盖：① 非空 SNAPSHOT 首渲染不抛错；② 水合窗口开关禁用（fail-closed）；
// ③ 本轮实时数据到达后开关/更新按钮解锁；④ 清单读取失败重新禁用。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../lib/client.js"), "utf8");

// ---------- 最小 React/hooks shim（只为让组件函数体真实执行） ----------
function makeRuntime() {
  const effects = [];
  const slots = [];
  let hookList = [];
  let cursor = 0;
  const node = (type, props) => ({ type, props: props || {}, children: undefined });
  const normalize = (kids) => (kids === undefined || kids === null ? [] : (Array.isArray(kids) ? kids : [kids]).flat(9).filter((k) => k !== null && k !== undefined && k !== false && k !== true));
  const ReactShim = {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, children: normalize(kids) }),
    Component: class { constructor(props) { this.props = props || {}; this.state = {}; } setState(p) { Object.assign(this.state, typeof p === "function" ? p(this.state) : p); } },
    useState(initial) {
      const i = cursor++;
      if (!(i in hookList)) hookList[i] = { v: typeof initial === "function" ? initial() : initial };
      const slot = hookList[i];
      return [slot.v, (v) => { slot.v = typeof v === "function" ? v(slot.v) : v; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in hookList)) hookList[i] = { current: initial }; return hookList[i]; },
    useEffect(fn) { effects.push(fn); const r = fn(); if (r && typeof r === "function") { /* cleanup 略 */ } }, // 诊断版：立即执行
    useCallback(fn) { return fn; },
  };
  const jsx = (type, props) => ({ type, props: { ...props, children: normalize(props && props.children) } });
  const jsxs = jsx;
  const prim = (name) => { const f = (props) => ({ __prim: name, props: props || {} }); f.__primName = name; return f; };
  const primitives = new Proxy({}, { get: (_, name) => (typeof name === "string" ? prim(name) : undefined) });
  return { ReactShim, jsx, jsxs, primitives, effects, hookList, resetCursor: () => { cursor = 0; } };
}

// ---------- localStorage shim（默认空 → 走构建期快照路径） ----------
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

// ---------- 加载真实客户端源码（stub __ModuleLoader__ 捕获工厂） ----------
let factory = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { factory = def.factory; } } };
(0, eval)(source);
if (!factory) throw new Error("client factory not captured");

// ---------- mock ctx / RPC ----------
const MARKET_URL = "https://oh-summy.github.io/dsh-nano-market/index.json";
const entries = [
  { name: "@oh-summy/dsh-remote", title: { zh: "dsh-remote 远程访问" }, description: { zh: "..." },
    versions: [{ version: "0.4.0", update: true, install: { spec: "git+https://github.com/oh-summy/dsh-nano-market.git#43f45eff17577fa4208d96c0a424c2042c85d781" } }],
    installation: { status: "update-available" } },
  { name: "@oh-summy/connect-lark", title: { zh: "connect-lark 飞书桥接" }, description: { zh: "..." },
    versions: [{ version: "0.3.0", update: false, install: { spec: "git+https://github.com/oh-summy/dsh-nano-market.git#8abfd8bc60a8a18c21f6335cdc0e973123576830" } }],
    installation: { status: "installed" } },
];
let listBundlesMode = "ok";
let effectCount = 0;
function makeCtx() {
  const registered = [];
  const ctx = {
    slots: { inject: (id, get) => { get(); }, register: (def, component) => { registered.push({ def, component }); return component; } }, // 宿主语义：注入即求值 register: (def, component) => { registered.push({ def, component }); return component; } },
    effect: () => {},
    locale: { bind: () => (k) => k, register: () => {} },
    remote: {
      pluginManager: { listBundles: async () => {
        if (listBundlesMode === "fail") throw new Error("listBundlesboom");
        return { ok: true, value: [
          { name: "@oh-summy/dsh-remote", installed: true, enabled: true, version: "0.3.0" },
          { name: "@oh-summy/connect-lark", installed: true, enabled: true, version: "0.3.0" },
        ] };
      } },
      $on: () => () => {},
      pluginMarket: {
        listIndexes: async () => ({ ok: true, value: [{ url: MARKET_URL }] }),
        search: async () => ({ ok: true, value: { entries } }),
      },
    },
  };
  ctx.registered = registered;
  return ctx;
}

// ---------- 渲染工具 ----------
const runtime = makeRuntime();
const requireMock = (name) => {
  if (name === "react") return runtime.ReactShim;
  if (name === "react/jsx-runtime") return { jsx: runtime.jsx, jsxs: runtime.jsxs };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return runtime.primitives;
  throw new Error("unexpected require: " + name);
};
const mod = factory(requireMock);
const ctx = makeCtx();
mod.apply(ctx);
if (ctx.registered.length !== 1) throw new Error("plugins.tab slot not registered");
const TabEntry = ctx.registered[0].component;
const props = { update: () => {}, openPackage: () => {}, install: () => {} };
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function collect(tree, within = null, acc = { rows: {} }) {
  if (!tree || typeof tree !== "object") return acc;
  const props = tree.props || {};
  // 函数组件：真实调用（渲染探针的核心——组件体内的 ReferenceError 只有调用才会暴露）
  if (typeof tree.type === "function" && !tree.type.__primName) {
    if (tree.type.name && /NanoMarket|Boundary/.test(tree.type.name)) console.log("DIAG 调用组件:", tree.type.name, "| effects:", runtime ? runtime.effects.length : "?");
    const isClass = /^class[\s{]/.test(String(tree.type));
    const out = isClass ? new tree.type(props).render() : tree.type({ ...props });
    return collect(out, within, acc);
  }
  const pkg = props["data-plugin-package"] || within;
  if (tree.type && tree.type.__primName === "Switch") {
    (acc.rows[pkg] ||= { switches: [], buttons: [] }).switches.push({ checked: Boolean(props.checked), disabled: Boolean(props.disabled) });
  }
  if (tree.type && tree.type.__primName === "Button") {
    (acc.rows[pkg] ||= { switches: [], buttons: [] }).buttons.push({ label: String(props.children), disabled: Boolean(props.disabled) });
  }
  const kids = props.children;
  if (Array.isArray(kids)) { for (const kid of kids) collect(kid, pkg, acc); }
  else if (kids && typeof kids === "object") { collect(kids, pkg, acc); }
  return acc;
}
function render() {
  runtime.effects.length = 0;
  runtime.resetCursor();
  return TabEntry(props);
}

test("渲染探针：非空快照首渲染不抛错、无安装按钮、水合窗口开关禁用（fail-closed）", async () => {
  const tree = render(); // 旧代码在此处抛 freshConfirmed ReferenceError（一轮 P0）
  const acc = collect(tree);
  assert.equal(Object.keys(acc.rows).length, 2);
  assert.ok(acc.rows["@oh-summy/dsh-remote"]);
  for (const row of Object.values(acc.rows)) {
    assert.equal(row.buttons.filter((b) => b.label === "install").length, 0, "不得再有安装按钮");
    for (const sw of row.switches) assert.equal(sw.disabled, true, "水合窗口（fresh=false）开关必须禁用");
  }
});

test("渲染探针：实时数据到达后开关解锁、可更新行出现可用更新按钮", async () => {
  const tree1 = render();
  collect(tree1); // 组件在此处真实执行（effects 入队）
  for (const fn of runtime.effects) await fn(); // 执行挂载 effects（refreshBundles + refreshMarket）
  await ticks();
  runtime.effects.length = 0;
  const tree2 = render(); // 状态已更新：bundlesFresh/marketFresh = true
  const acc = collect(tree2);
  const remote = acc.rows["@oh-summy/dsh-remote"];
  const lark = acc.rows["@oh-summy/connect-lark"];
  assert.ok(remote && lark, "实时数据后两行都渲染");
  for (const sw of remote.switches) assert.equal(sw.disabled, false, "bundlesFresh 后开关解锁");
  for (const sw of lark.switches) assert.equal(sw.disabled, false);
  const updates = remote.buttons.filter((b) => b.label === "update");
  assert.equal(updates.length, 1, "可更新行应有更新按钮");
  for (const b of updates) assert.equal(b.disabled, false, "marketFresh 后更新按钮解锁");
  assert.equal(lark.buttons.filter((b) => b.label === "update").length, 0, "已最新行不得有更新按钮");
});

test("渲染探针：清单读取失败 → 开关重新禁用（不按陈旧状态操作）", async () => {
  listBundlesMode = "fail";
  const tree1 = render();
  collect(tree1);
  for (const fn of runtime.effects) await fn();
  await ticks();
  runtime.effects.length = 0;
  const tree2 = render();
  const acc = collect(tree2);
  assert.ok(Object.keys(acc.rows).length >= 1, "读取失败路径也必须渲染出插件行（不得被边界吞成空树）");
  for (const row of Object.values(acc.rows)) for (const sw of row.switches) assert.equal(sw.disabled, true);
  listBundlesMode = "ok";
});
