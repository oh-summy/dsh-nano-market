import { test } from "node:test";
import assert from "node:assert/strict";
import { passesWhitelist, downloadInboundImage, MAX_IMAGE_BYTES, RunManager } from "../lib/index.mjs";

// ---- passesWhitelist ----

test("passesWhitelist: empty both = deny all", () => {
  const plain = { senderAllowlist: [], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_1"), false);
});

test("passesWhitelist: single dimension = deny (fail-closed)", () => {
  const senderOnly = { senderAllowlist: ["ou_allowed"], groupAllowlist: [] };
  assert.equal(passesWhitelist(senderOnly, "chat-1", "ou_allowed"), false);
  const groupOnly = { senderAllowlist: [], groupAllowlist: ["oc_allowed"] };
  assert.equal(passesWhitelist(groupOnly, "oc_allowed", "ou_1"), false);
});

test("passesWhitelist: both lists required", () => {
  const plain = { senderAllowlist: ["ou_a"], groupAllowlist: ["oc_x"] };
  assert.equal(passesWhitelist(plain, "oc_x", "ou_a"), true);
  assert.equal(passesWhitelist(plain, "oc_x", "ou_b"), false);
  assert.equal(passesWhitelist(plain, "oc_y", "ou_a"), false);
});

// ---- downloadInboundImage SSRF ----

test("downloadInboundImage: rejects non-https", async () => {
  await assert.rejects(() => downloadInboundImage("http://example.com/img.png"), /must be https/);
});

test("downloadInboundImage: rejects non-CDN host", async () => {
  await assert.rejects(() => downloadInboundImage("https://evil.com/img.png"), /host not in allowed/);
});

test("downloadInboundImage: rejects invalid URL", async () => {
  await assert.rejects(() => downloadInboundImage("not a url"), /invalid image URL/);
});

// ---- RunManager complete/cancelling ----

test("RunManager: complete() works after cancelling", async () => {
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, handle: { dispose: async () => {} } }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => {},
    onComplete: () => {},
  });
  const slot = await mgr.start("chat-1", "hello", { kind: "user" });
  mgr.cancel("chat-1");
  assert.equal(slot.state, "cancelling");
  assert.ok(slot.cancelController?.signal.aborted);
});

test("RunManager: cancel on idle slot is a no-op", async () => {
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, handle: { dispose: async () => {} } }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => {},
  });
  mgr.cancel("never-started");
  assert.equal(mgr.isRunning("never-started"), false);
});

test("RunManager: disposeAll works with no active runs", async () => {
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, handle: { dispose: async () => {} } }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => {},
  });
  await mgr.disposeAll();
  assert.equal(mgr.list().length, 0);
});