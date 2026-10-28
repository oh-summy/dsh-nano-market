import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const expectedFields = [
  "appId", "appSecretPreview", "domain", "defaultPath", "provider", "model", "reasoningEffort", "permissionPreset",
];

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
    field(path) { return { path, text: "" }; }
    shell() { return { writable: true }; }
    actions() { return { save() {}, discard() {}, edit(path, text) { edits.push([path, text]); }, resetField() {} }; }
    dispose() {}
  }
  const primitives = {
    SettingsFormModel,
    settingsTextField: (path) => ({ path }),
    SettingsForm: () => null,
    SettingsValueField: () => null,
  };
  const sandbox = {
    window,
    document: { querySelectorAll: () => globalThis.__dshWorkspaceButtons || [] },
    console,
    require(name) {
      if (name === "react") return { createElement: () => null, useId: () => "test" };
      if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
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
  assert.doesNotMatch(source, /connect-lark-requireMention|connect-lark-senderAllowlist|cl-trigger-note/);
});
