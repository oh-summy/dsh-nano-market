import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const expectedFields = [
  "appId", "appSecretPreview", "domain", "accessMode", "openId", "senderAllowlist", "groupAllowlist",
  "defaultPath", "provider", "model", "reasoningEffort", "permissionPreset",
];

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
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  collectText(node.props?.children, out);
  return out;
}

function collectButtons(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const item of node) collectButtons(item, out); return out; }
  if (node.type === "button") out.push(node);
  collectButtons(node.props?.children, out);
  return out;
}

function applyMinimal(loaded) {
  // The field definitions are captured when the settings model is constructed,
  // so a field lookup needs one apply() on the same client instance.
  if (loaded.definitions.length > 0) return;
  const ctx = {
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
      directoryPicker: { list: async () => ({ ok: true, value: { path: "/tmp" } }) },
      credentials: { set: async () => ({ ok: true }) },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    locale: { bind: () => (key) => key, register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: {} }) }),
      whileServed: (ids, register) => register(new Set(ids)),
    },
    slots: {
      inject: () => () => {},
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
    get(name) { return name === "workspaces" ? this.workspaces : undefined; },
  };
  loaded.exports.apply(ctx);
}

function loadClient() {
  const source = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value; },
    },
  };
  const fields = [];
  const edits = [];
  const saved = [];
  const capturedDefinitions = [];
  // Mirror the host semantics: fields are TEXT, parse() validates, and an
  // unparsable stage marks the shell invalid (the host then disables Save).
  class SettingsFormModel {
    constructor(scope, definitions) {
      this.scope = scope;
      this.definitions = definitions;
      this.staged = new Map();
      capturedDefinitions.push(...definitions);
      fields.push(...definitions.map((item) => item.path));
    }
    bind(project) { return { getSnapshot: project }; }
    field(path) {
      const def = this.definitions.find((d) => d.path === path);
      if (this.staged.has(path)) return { path, text: this.staged.get(path) };
      const raw = this.scope?.getSnapshot?.()?.value?.[path];
      const text = def?.format ? def.format(raw) : String(raw ?? "");
      return { path, text };
    }
    plan() {
      const ops = [];
      for (const [path, text] of this.staged) {
        const def = this.definitions.find((d) => d.path === path);
        const parsed = def?.parse ? def.parse(text) : undefined;
        if (!parsed) return { ops: [], invalid: true };
        ops.push({ path, ...parsed });
      }
      return { ops, invalid: false };
    }
    shell() { return { writable: true, invalid: this.plan().invalid, dirty: this.staged.size > 0 }; }
    actions() {
      return {
        save: () => {
          const { ops, invalid } = this.plan();
          if (invalid) return false;
          this.saved.push(...ops);
          return true;
        },
        discard: () => { this.staged.clear(); },
        edit: (path, text) => {
          edits.push([path, text]);
          this.staged.set(path, text);
        },
        resetField: () => {},
      };
    }
    dispose() {}
  }
  const primitives = {
    SettingsFormModel,
    settingsTextField: (path) => ({ path, format: (t) => typeof t === "string" ? t : "" }),
    SettingsForm: ({ children }) => children,
    SettingsValueField: ({ children }) => children,
    // Host shape: Modal renders body + footer (chrome omitted in tests),
    // SettingsSecretField renders label + hint, Button renders a real button element.
    Button: ({ children, ...props }) => ({ type: "button", props: { ...props, children } }),
    Modal: ({ children, footer }) => ({ type: "div", props: { children: [children, footer].filter(Boolean) } }),
    SettingsSecretField: ({ label, hint }) => ({ type: "span", props: { children: [label, hint] } }),
  };
  const sandbox = {
    window,
    fetch: async () => { throw new Error("no directory service in tests"); },
    document: { querySelectorAll: () => globalThis.__dshWorkspaceButtons || [] },
    console,
    require(name) {
      if (name === "react") return {
        createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length ? children : (props && props.children) } }),
        useId: () => "test",
        useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useRef: (initial) => ({ current: initial }),
        useEffect: (fn) => { try { fn(); } catch { /* component under test may need a host runtime */ } },
      };
      if (name === "react/jsx-runtime") return {
        jsx: (type, props) => ({ type, props: props || {} }),
        jsxs: (type, props) => ({ type, props: props || {} }),
      };
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
      if (name === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: (value) => ({ value, getSnapshot: () => value, set(next) { this.value = next; }, subscribe: () => () => {} }) };
      throw new Error("unexpected module " + name);
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(registration, "client module registration missing");
  const exports = registration.factory(sandbox.require);
  return { exports, fields, definitions: capturedDefinitions, edits, saved };
}

test("package exposes a web client configuration page", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.equal(pkg.dsh.client?.platform, "web");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.match(pkg.scripts.build, /build-client.mjs/);
});

test("client registers the native bundle config slot and all fields", async () => {
  const { exports, fields, definitions, edits } = loadClient();
  assert.deepEqual(Array.from(exports.inject), ["slots", "locale", "remote", "remote.session", "remote.directoryPicker", "workspaces", "configForms"]);

  const calls = { get: [], served: [], slots: [] };
  let workspaceItems = [];
  globalThis.__dshWorkspaceButtons = [{ classList: { contains: () => false }, click() { workspaceItems = [{ workspaceId: "ws-new", path: "/tmp/dsh-workspace", title: "test" }]; } }];
  const ctx = {
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
      directoryPicker: {
        list: async () => ({ ok: true, value: { path: "/tmp", home: "/Users/rocky", crumbs: [], entries: [], truncated: false } }),
        createDirectory: async (path, name) => ({ ok: true, value: path + "/" + name }),
      },
      credentials: { set: async () => ({ ok: true }) },
    },
    workspaces: {
      list: { getSnapshot: () => ({ items: workspaceItems }), subscribe: () => () => {} },
      create: async ({ path }) => ({ workspaceId: "ws-test", path }),
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    configForms: {
      get: (id) => { calls.get.push(id); return { id, getSnapshot: () => ({ value: { appSecretRef: "CONNECT_LARK_APP_SECRET" } }) }; },
      whileServed: (ids, register) => {
        calls.served.push(ids);
        return register(new Set(ids));
      },
    },
    slots: {
      inject: (name, register) => { calls.slots.push({ name, register }); return () => {}; },
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
    get(name) { return name === "workspaces" ? this.workspaces : undefined; },
  };
  exports.apply(ctx);
  assert.deepEqual(Array.from(fields).sort(), [...expectedFields].sort());
  assert.deepEqual(calls.get, ["connect-lark"]);
  assert.deepEqual(calls.served.map((ids) => Array.from(ids)), [["connect-lark"]]);
  const injected = calls.slots.find((call) => call.name === "plugins.bundle.config");
  assert.ok(injected, "plugins.bundle.config not registered");
  const slot = injected.register();
  assert.equal(slot.options.key, "@oh-summy/connect-lark");
  assert.equal(slot.options.name, "plugins.bundle.config");
  const byPath = Object.fromEntries(definitions.map((item) => [item.path, item]));
  assert.ok(byPath.domain, "domain switch field missing");
  const actions = slot.options.inject();
  assert.equal(typeof actions.listDirectory, "function");
  const listing = await actions.listDirectory();
  assert.equal(listing.path, "/tmp");
  await actions.saveSecret("rmU5Dsecret");
  assert.ok(edits.some(([path, value]) => path === "appSecretPreview" && value === "rmU5D"));
  delete globalThis.__dshWorkspaceButtons;
  const source = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
  assert.match(source, /https:\/\/open\.feishu\.cn\/app/);
  assert.doesNotMatch(source, /connect-lark-requireMention|cl-trigger-note/);
});


test("client renders the actual configuration card and domain controls", () => {
  const { exports, edits } = loadClient();
  let injected;
  const ctx = {
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
      directoryPicker: { list: async () => ({ ok: true, value: { path: "/tmp" } }) },
      credentials: { set: async () => ({ ok: true }) },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    locale: { bind: () => (key) => key, register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: {} }) }),
      whileServed: (ids, register) => register(new Set(ids)),
    },
    slots: {
      inject: (name, register) => { injected = register(); return () => {}; },
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
    get(name) { return name === "workspaces" ? this.workspaces : undefined; },
  };
  exports.apply(ctx);
  const actions = injected.options.inject();
  const state = actions.hooks.larkSettings.getSnapshot();
  const tree = renderElement(injected.component({
    ...actions,
    useLarkSettings: (selector) => selector(state),
    t: (key) => key,
  }));
  const text = collectText(tree).join(" ");
  assert.match(text, /heroTitle/);
  assert.match(text, /appId/);
  // 权限选择器已全部走字典（t 在测试里返回键名），不再有字典外的中文硬编码。
  assert.match(text, /permissionLabel/);
  assert.doesNotMatch(text, /权限模式/);
  const larkButton = collectButtons(tree).find((button) =>
    button.props.role === "radio" && collectText(button).includes("lark"));
  assert.ok(larkButton, "rendered Lark domain radio button missing");
  larkButton.props.onClick();
  assert.ok(edits.some(([path, value]) => path === "domain" && value === "lark"));
});


test("client renders the access control section with mode and openId controls", () => {
  const { exports } = loadClient();
  let injected;
  const ctx = {
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
      directoryPicker: { list: async () => ({ ok: true, value: { path: "/tmp" } }) },
      credentials: { set: async () => ({ ok: true }) },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    locale: { bind: () => (key) => key, register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: {} }) }),
      whileServed: (ids, register) => register(new Set(ids)),
    },
    slots: {
      inject: (name, register) => { injected = register(); return () => {}; },
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
    get(name) { return name === "workspaces" ? this.workspaces : undefined; },
  };
  exports.apply(ctx);
  const actions = injected.options.inject();
  const state = actions.hooks.larkSettings.getSnapshot();
  const tree = renderElement(injected.component({
    ...actions,
    useLarkSettings: (selector) => selector(state),
    t: (key) => key,
  }));
  const text = collectText(tree).join(" ");
  assert.match(text, /accessApp/);
  assert.match(text, /accessList/);
  assert.match(text, /accessAppHint/);
  assert.match(text, /accessAppHint/);
  // restricted mode should be the default selected
  const appBtn = collectButtons(tree).find((b) =>
    b.props.role === "radio" && collectText(b).includes("accessApp"));
  const listBtn = collectButtons(tree).find((b) =>
    b.props.role === "radio" && collectText(b).includes("accessList"));
  assert.ok(appBtn, "app-scope radio should render");
  assert.ok(listBtn, "explicit-list radio should render");
  assert.equal(appBtn.props["aria-checked"], true, "app scope is the default");
  // Switching to the explicit-list mode triggers an edit
  listBtn.props.onClick();
});


test("client list mode shows the unified people-and-groups picker", () => {
  const { exports } = loadClient();
  let injected;
  const ctx = {
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
      directoryPicker: { list: async () => ({ ok: true, value: { path: "/tmp" } }) },
      credentials: { set: async () => ({ ok: true }) },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } },
    locale: { bind: () => (key) => key, register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: { accessMode: "list", senderAllowlist: ["ou_a", "ou_b"], groupAllowlist: ["oc_x"] } }) }),
      whileServed: (ids, register) => register(new Set(ids)),
    },
    slots: {
      inject: (name, register) => { injected = register(); return () => {}; },
      register: (options, component) => ({ options, component }),
    },
    effect: (fn) => fn(),
    get(name) { return name === "workspaces" ? this.workspaces : undefined; },
  };
  exports.apply(ctx);
  const actions = injected.options.inject();
  const state = actions.hooks.larkSettings.getSnapshot();
  const tree = renderElement(injected.component({
    ...actions,
    useLarkSettings: (selector) => selector(state),
    t: (key) => key,
  }));
  const text = collectText(tree).join("\n");
  // One search box finds both people and groups; the old separate editors are gone.
  assert.match(text, /pickUser/);
  assert.doesNotMatch(text, /senderAllowlist/);
  assert.doesNotMatch(text, /groupAllowlist/);
});



test("client access mode choices accept the values the UI writes", () => {
  const loaded = loadClient();
  applyMinimal(loaded);
  const { definitions } = loaded;
  const accessMode = definitions.find((item) => item.path === "accessMode");
  assert.ok(accessMode, "accessMode field missing");
  assert.deepEqual([...accessMode.choices].sort(), ["app", "list"]);
  // The values the segmented control writes must parse.
  assert.equal(accessMode.parse("app").value, "app");
  assert.equal(accessMode.parse("list").value, "list");
  // Legacy values map onto the new pair instead of becoming invalid.
  assert.equal(accessMode.parse("open").value, "app");
  assert.equal(accessMode.parse("restricted").value, "list");
});

test("client list fields round-trip arrays through text", () => {
  const loaded = loadClient();
  applyMinimal(loaded);
  const { definitions } = loaded;
  const sender = definitions.find((item) => item.path === "senderAllowlist");
  assert.ok(sender, "senderAllowlist field missing");
  assert.equal(sender.format(["ou_a", "ou_b"]), "ou_a\nou_b");
  const parsed = sender.parse("ou_a\nou_b");
  assert.equal(Array.from(parsed.value).join(","), "ou_a,ou_b");
});

test("client grants access by appending to the list as text", () => {
  const { exports } = loadClient();
  assert.equal(typeof exports.grantToList, "function", "grantToList must be exported");
  // Adding a new person keeps the existing grants.
  assert.equal(exports.grantToList("ou_a\nou_b", "ou_c"), "ou_a\nou_b\nou_c");
  // Adding the same person again does not duplicate.
  assert.equal(exports.grantToList("ou_a\nou_b", "ou_a"), "ou_a\nou_b");
  // An empty list starts fresh.
  assert.equal(exports.grantToList("", "ou_a"), "ou_a");
});

