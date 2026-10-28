import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const stubUrl = "data:text/javascript," + encodeURIComponent(`
export function createLarkChannel(options) {
  return globalThis.__connectLarkTestChannel.create(options);
}
`);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@larksuite/channel") return { url: stubUrl, shortCircuit: true };
    return next(specifier, context);
  },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("apply connects and disconnects on volatile enabled updates", async () => {
  const calls = { create: 0, connect: 0, disconnect: 0, domains: [] };
  globalThis.__connectLarkTestChannel = {
    create(options) {
      calls.create++;
      calls.domains.push(options.domain);
      return {
        async connect() { calls.connect++; },
        async disconnect() { calls.disconnect++; },
        on() { return () => {}; },
        async send() {},
      };
    },
  };
  const listeners = new Map();
  let disposer;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    credentials: { resolve: async () => ({ value: "test-secret" }) },
    effect(fn) { disposer = fn(); },
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
  const config = {
    enabled: false,
    appId: "cli_test",
    appSecretRef: "CONNECT_LARK_TEST",
    defaultPath: "",
    openId: "",
    domain: "feishu",
    requireMention: true,
    agentOwnership: "attach-gui",
    attachSessionId: "session-test",
    provider: "",
    model: "",
    senderAllowlist: ["ou_test"],
    groupAllowlist: ["oc_test"],
    thinkingPolicy: "stream-only",
  };
  const { apply } = await import("../lib/index.mjs");
  apply(ctx, config);
  await settle();
  assert.equal(calls.create, 1, "the enabled plugin bundle owns the connection lifecycle");
  assert.equal(calls.connect, 1, "legacy config.enabled is not a second switch");
  assert.equal(calls.domains[0], "https://open.feishu.cn");

  config.appId = "cli_test_changed";
  config.domain = "lark";
  listeners.get("loader/volatile-update")();
  await settle();
  assert.equal(calls.disconnect, 1, "saving a change reconnects the old channel");
  assert.equal(calls.create, 2);
  assert.equal(calls.connect, 2);
  assert.equal(calls.domains[1], "https://open.larksuite.com");
  await disposer?.();
  delete globalThis.__connectLarkTestChannel;
});
