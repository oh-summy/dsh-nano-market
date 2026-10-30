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
  const capturedDefinitions = [];
  class SettingsFormModel {
    constructor(scope, definitions) {
      this.scope = scope;
      this.definitions = definitions;
      capturedDefinitions.push(...definitions);
      fields.push(...definitions.map((item) => item.path));
    }
    bind(project) { return { getSnapshot: project }; }
    field(path) {
      const def = this.definitions.find((d) => d.path === path);
      const raw = this.scope?.getSnapshot?.()?.value?.[path];
      const text = def?.format ? def.format(raw) : String(raw ?? "");
      return { path, text };
    }
    shell() { return { writable: true }; }
    actions() { return { save() {}, discard() {}, edit(path, text) { edits.push([path, text]); }, resetField() {} }; }
    dispose() {}
  }
  const primitives = {
    SettingsFormModel,
    settingsTextField: (path) => ({ path, format: (t) => typeof t === "string" ? t : "" }),
    SettingsForm: ({ children }) => children,
    SettingsValueField: ({ children }) => children,
  };
  const sandbox = {
    window,
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
        useEffect: () => {},
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
  return { exports, fields, definitions: capturedDefinitions, edits };
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
  assert.match(text, /权限模式/);
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
  assert.match(text, /accessRestricted/);
  assert.match(text, /accessOpen/);
  assert.match(text, /openId/);
  // restricted mode should be the default selected
  const restrictedBtn = collectButtons(tree).find((b) =>
    b.props.role === "radio" && collectText(b).includes("accessRestricted"));
  assert.ok(restrictedBtn, "restricted radio should render");
  assert.equal(restrictedBtn.props["aria-checked"], true);
  // Switching to open mode triggers an edit
  const openBtn = collectButtons(tree).find((b) =>
    b.props.role === "radio" && collectText(b).includes("accessOpen"));
  openBtn.props.onClick();
});


test("client list fields render existing array values as text", () => {
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
      get: () => ({ getSnapshot: () => ({ value: { senderAllowlist: ["ou_a", "ou_b"], groupAllowlist: ["oc_x"] } }) }),
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
  const textareas = [];
  (function collectTextareas(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) collectTextareas(item); return; }
    if (node.type === "textarea") { textareas.push(node); return; }
    collectTextareas(node.props?.children);
  })(tree);
  assert.ok(textareas.length >= 2, "should render sender and group allowlist textareas");
  const senderText = textareas[0].props?.value || "";
  const groupText = textareas[1].props?.value || "";
  assert.ok(senderText.includes("ou_a"), "sender allowlist should show existing values");
  assert.ok(groupText.includes("oc_x"), "group allowlist should show existing values");
});
