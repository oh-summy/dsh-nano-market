import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const expectedFields = [
  "enabled", "appId", "appSecretRef", "defaultPath", "openId", "domain",
  "requireMention", "agentOwnership", "attachSessionId", "provider", "model",
  "senderAllowlist", "groupAllowlist", "thinkingPolicy",
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
    actions() { return { save() {}, discard() {}, edit() {}, resetField() {} }; }
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
    console,
    require(name) {
      if (name === "react") return { createElement: () => null, useId: () => "test" };
      if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
      throw new Error("unexpected module " + name);
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(registration, "client module registration missing");
  const exports = registration.factory(sandbox.require);
  return { exports, fields, definitions: capturedDefinitions };
}

test("package exposes a web client configuration page", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.equal(pkg.dsh.client?.platform, "web");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.match(pkg.scripts.build, /build-client.mjs/);
});

test("client registers the native bundle config slot and all fields", () => {
  const { exports, fields, definitions } = loadClient();
  assert.deepEqual(Array.from(exports.inject), ["slots", "locale", "configForms"]);

  const calls = { get: [], served: [], slots: [] };
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    configForms: {
      get: (id) => { calls.get.push(id); return { id }; },
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
  assert.equal(byPath.requireMention.format(true), "true");
  assert.equal(byPath.requireMention.format(false), "false");
  assert.equal(byPath.senderAllowlist.format(["ou_a", "ou_b"]), "ou_a\nou_b");
  assert.deepEqual(Array.from(byPath.senderAllowlist.parse("ou_a, ou_b\nou_a").value), ["ou_a", "ou_b"]);
});
