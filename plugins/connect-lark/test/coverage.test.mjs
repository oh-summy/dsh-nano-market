import { test } from "node:test";
import assert from "node:assert/strict";
import { passesWhitelist, downloadInboundImage, MAX_IMAGE_BYTES, RunManager } from "../lib/index.mjs";

// ---- passesWhitelist ----

test("passesWhitelist: empty lists allow everyone by default", () => {
  const plain = { senderAllowlist: [], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_1", "p2p"), true);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_1", "group"), true);
});

test("passesWhitelist: sender list optionally restricts only private chats", () => {
  const plain = { senderAllowlist: ["ou_allowed"], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_allowed", "p2p"), true);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_other", "p2p"), false);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_other", "group"), true);
});

test("passesWhitelist: group list optionally restricts only group chats", () => {
  const plain = { senderAllowlist: [], groupAllowlist: ["oc_allowed"] };
  assert.equal(passesWhitelist(plain, "oc_allowed", "ou_1", "group"), true);
  assert.equal(passesWhitelist(plain, "oc_other", "ou_1", "group"), false);
  assert.equal(passesWhitelist(plain, "oc_other", "ou_1", "p2p"), true);
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