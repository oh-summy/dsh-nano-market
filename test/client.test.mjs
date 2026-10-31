import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// dsh-remote 的 client 测试：整模块在 vm 沙盒里加载（原语用最小 mock），
// 渲染详情页组件，保证重写后的 React 管理面真的画得出来、字典双语对齐、
// 且不再出现手写原语时代的反模式（window.confirm、硬编码色板）。

function loadClient() {
  const source = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value; },
    },
  };
  const primitives = {
    Button: ({ children, ...props }) => ({ type: "button", props: { ...props, children } }),
    Switch: ({ children, ...props }) => ({ type: "button", props: { ...props, children } }),
    Tag: ({ children }) => ({ type: "span", props: { children } }),
    Tooltip: ({ children }) => children,
    Modal: ({ children, footer, open }) => open ? ({ type: "div", props: { children: [children, footer].filter(Boolean) } }) : null,
    Input: (props) => ({ type: "input", props }),
    SegmentedControl: ({ options }) => ({ type: "div", props: { children: options.map((o) => o.label) } }),
    IconQuestionOutlineRegular: () => ({ type: "span", props: { children: "?" } }),
  };
  const sandbox = {
    window,
    location: { port: "3080" },
    fetch: async () => { throw new Error("no manager in tests"); },
    AbortSignal: { timeout: () => null },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    require(name) {
      if (name === "react") return {
        createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length ? children : (props && props.children) } }),
        useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
        useRef: (initial) => ({ current: initial }),
        useCallback: (fn) => fn,
        useEffect: (fn) => { try { fn(); } catch { /* no host runtime here */ } },
      };
      if (name === "react/jsx-runtime") return {
        jsx: (type, props) => ({ type, props: props || {} }),
        jsxs: (type, props) => ({ type, props: props || {} }),
        Fragment: "Fragment",
      };
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
      throw new Error("unexpected module " + name);
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(registration, "client module registration missing");
  const exports = registration.factory(sandbox.require);
  return { exports, sandbox };
}

function renderElement(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(renderElement).filter(Boolean);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return renderElement(node.type(node.props || {}));
  return { ...node, props: { ...(node.props || {}), children: renderElement(node.props?.children) } };
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const item of node) collectText(item, out); return out; }
  if (typeof node !== "object") { out.push(String(node)); return out; }
  collectText(node.props?.children, out);
  return out;
}

function applyWithCapture(loaded) {
  const registered = [];
  const dictionaries = [];
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {}; },
    },
    slots: {
      inject: (name, register) => { registered.push({ name, register }); return () => {}; },
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
  };
  loaded.exports.apply(ctx);
  return { registered, dictionaries };
}

test("client registers the keyed config slot with a locale namespace", () => {
  const loaded = loadClient();
  const { registered, dictionaries } = applyWithCapture(loaded);
  const injected = registered.find((call) => call.name === "plugins.bundle.config");
  assert.ok(injected, "plugins.bundle.config not registered");
  const slot = injected.register();
  assert.equal(slot.options.name, "plugins.bundle.config");
  assert.equal(slot.options.key, "@oh-summy/dsh-remote");
  assert.equal(slot.options.locale, "dshRemote");
  // 双语字典都注册了，且键集完全对齐——en 不能再是 zh 的复制品或缺角。
  const dicts = dictionaries.find((d) => d.ns === "dshRemote").dicts;
  assert.ok(dicts.zh && dicts.en, "both zh and en dictionaries must register");
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort());
  assert.notEqual(dicts.en.statusRunning, dicts.zh.statusRunning, "en must be translated, not a zh copy");
});

test("client renders the full management page through host primitives", () => {
  const loaded = loadClient();
  const { registered } = applyWithCapture(loaded);
  const injected = registered.find((call) => call.name === "plugins.bundle.config");
  const slot = injected.register();
  // page 视图渲染管理面；summary 视图不画任何东西。
  assert.equal(slot.component({ view: "summary", t: (key) => key }), null);
  const tree = renderElement(slot.component({ view: "page", t: (key) => key }));
  const text = collectText(tree).join(" ");
  // 常驻区块（与运行状态无关的部分）必须出现；密码/链接行只在隧道运行时渲染，
  // 沙盒里没有管理面 API，state 恒为 null。
  for (const key of ["statusReading", "notify", "sessionDays", "autoRestart", "envTitle", "eventsTitle"]) {
    assert.ok(text.includes(key), `management page must render ${key}`);
  }
  // 交互全部落在宿主原语上：沙盒里 state 为 null、通知关闭，可见的两个开关
  // （通知/自动重启）都是宿主 Switch（mock 渲染成 button），其余按钮按状态门控。
  const buttons = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "button") buttons.push(node);
    walk(node.props?.children);
  })(tree);
  assert.ok(buttons.length >= 2, `expected host switches on the page, got ${buttons.length}`);
});

test("the hand-rolled era is gone: no window.confirm and no hardcoded palette", () => {
  const source = readFileSync(join(pkgDir, "client-src/client.js"), "utf8");
  assert.doesNotMatch(source, /window\.confirm|[^.\w]confirm\(/);
  assert.match(source, /@deepseek-ai\/dsh-client-ui-primitives/);
  for (const call of ["P.Switch", "P.Button", "P.Tooltip", "P.Modal", "P.SegmentedControl", "P.Tag"]) {
    assert.ok(source.includes(call), `expected host primitive ${call}`);
  }
  // 硬编码浅色时代的代表色一个都不能回来；颜色只允许 --dsw-* 令牌。
  assert.doesNotMatch(source, /#fff\b|#1f2328|#2563eb|#eef0f3|#f6f7f9|#16a34a|#dc2626/i);
  assert.match(source, /--dsw-alias-/);
});
