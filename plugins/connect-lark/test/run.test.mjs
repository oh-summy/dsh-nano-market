import { test } from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../lib/index.mjs";

function makeManager() {
  const calls = { resolveAgent: 0, followup: 0, subscribe: 0, dispose: 0 };
  let deltaCb = null;
  let turnEndCb = null;
  let errorCb = null;

  const mgr = new RunManager({
    resolveAgent: async (chatId) => {
      calls.resolveAgent++;
      return { agent: { id: "agent-" + chatId }, handle: { dispose: async () => { calls.dispose++; } } };
    },
    buildMessage: (content, source) => ({ id: "msg-" + Date.now(), content, source }),
    subscribe: (agent, sessionId, onDelta, onTurnEnd, onError) => {
      calls.subscribe++;
      deltaCb = onDelta;
      turnEndCb = onTurnEnd;
      errorCb = onError;
      return () => {};
    },
    followup: (agent, message) => { calls.followup++; },
    onComplete: () => {},
  });

  return { mgr, calls, getDelta: () => deltaCb, getTurnEnd: () => turnEndCb, getError: () => errorCb };
}

test("RunManager: creates slot on first start", async () => {
  const { mgr, calls } = makeManager();
  const slot = await mgr.start("chat-1", "hello", { kind: "user" });
  assert.equal(slot.chatId, "chat-1");
  assert.equal(slot.state, "running");
  assert.equal(calls.resolveAgent, 1);
  assert.equal(calls.followup, 1);
});

test("RunManager: queues message when running", async () => {
  const { mgr, calls } = makeManager();
  await mgr.start("chat-1", "first", { kind: "user" });
  const slot2 = await mgr.start("chat-1", "second", { kind: "user" });
  assert.equal(slot2.pending.length, 1);
  assert.equal(calls.resolveAgent, 1);
});

test("RunManager: cancel aborts controller", async () => {
  const { mgr } = makeManager();
  const slot = await mgr.start("chat-1", "hello", { kind: "user" });
  mgr.cancel("chat-1");
  assert.equal(slot.state, "cancelling");
  assert.ok(slot.cancelController?.signal.aborted);
});

test("RunManager: disposeAll clears slots", async () => {
  const { mgr, calls } = makeManager();
  await mgr.start("chat-1", "hello", { kind: "user" });
  await mgr.disposeAll();
  assert.equal(mgr.list().length, 0);
  assert.equal(calls.dispose, 1);
});

test("RunManager: isRunning reports correctly", async () => {
  const { mgr } = makeManager();
  assert.equal(mgr.isRunning("chat-1"), false);
  await mgr.start("chat-1", "hello", { kind: "user" });
  assert.equal(mgr.isRunning("chat-1"), true);
});

test("RunManager: accumulates deltas", async () => {
  const { mgr, getDelta } = makeManager();
  const slot = await mgr.start("chat-1", "hello", { kind: "user" });
  getDelta()("Hello");
  getDelta()(" World");
  assert.equal(slot.accumulatedText, "Hello World");
});