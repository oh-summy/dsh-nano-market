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

test("RunManager: forwards the first message title to resolveAgent", async () => {
  let received;
  const mgr = new RunManager({
    resolveAgent: async (chatId, title) => {
      received = { chatId, title };
      return { agent: { id: "a" }, sessionId: "s1", handle: null };
    },
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => {},
  });
  await mgr.start("chat-1", "hello", { kind: "user" }, "你是干啥的？现在什么环境");
  assert.deepEqual(received, { chatId: "chat-1", title: "你是干啥的？现在什么环境" });
});


test("RunManager: emits start, text and reasoning callbacks", async () => {
  let deltaCb;
  const calls = [];
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "s1", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: (agent, sessionId, onDelta) => {
      deltaCb = onDelta;
      return () => {};
    },
    followup: () => {},
    onStart: (slot) => { calls.push(["start", slot.chatId]); },
    onDelta: (slot, delta) => { calls.push(["text", delta]); },
    onThinking: (slot, delta) => { calls.push(["reasoning", delta]); },
  });
  const slot = await mgr.start("chat-1", "hello", { kind: "user" });
  deltaCb("answer", "text");
  deltaCb("think", "reasoning");
  assert.equal(slot.accumulatedText, "answer");
  assert.equal(slot.thinkingText, "think");
  assert.deepEqual(calls, [["start", "chat-1"], ["text", "answer"], ["reasoning", "think"]]);
});


test("RunManager: serializes concurrent starts for one chat", async () => {
  let resolveCount = 0;
  let followupCount = 0;
  const mgr = new RunManager({
    resolveAgent: async () => {
      resolveCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { agent: { id: "a" }, sessionId: "s1", handle: null };
    },
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => { followupCount++; },
  });
  await Promise.all([
    mgr.start("chat-1", "first", { kind: "user" }),
    mgr.start("chat-1", "second", { kind: "user" }),
  ]);
  assert.equal(resolveCount, 1);
  assert.equal(followupCount, 1);
  const slot = mgr.getSlot("chat-1");
  assert.equal(slot.pending.length, 1);
  assert.equal(slot.pending[0].content, "second");
});


test("RunManager: disposeAll finishes active streaming producers", async () => {
  let finished = false;
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "s1", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => {},
  });
  const slot = await mgr.start("chat-1", "hello", { kind: "user" });
  slot.streamDone = () => { finished = true; };
  await mgr.disposeAll();
  assert.equal(finished, true);
});


test("RunManager: resets failure and stream state on the next turn", async () => {
  let errorCb;
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "s1", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: (agent, sessionId, onDelta, onTurnEnd, onError) => {
      errorCb = onError;
      return () => {};
    },
    followup: () => {},
    onComplete: () => {},
  });
  const slot = await mgr.start("chat-1", "first", { kind: "user" });
  slot.streamFailed = new Error("old stream");
  slot.streamController = { update: async () => {} };
  errorCb(new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await mgr.start("chat-1", "second", { kind: "user" });
  assert.equal(slot.failedWith, undefined);
  assert.equal(slot.streamFailed, undefined);
  assert.equal(slot.streamController, undefined);
});

test("RunManager: rejects a second chat sharing a busy session", async () => {
  let followups = 0;
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "shared", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => { followups++; },
  });
  await mgr.start("chat-1", "first", { kind: "user" });
  await assert.rejects(() => mgr.start("chat-2", "second", { kind: "user" }), /busy|already running/);
  assert.equal(followups, 1);
});

test("RunManager: waits for onComplete before draining queued work", async () => {
  let turnEnd;
  let followups = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "s1", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: (agent, sessionId, onDelta, onTurnEnd) => {
      turnEnd = onTurnEnd;
      return () => {};
    },
    followup: () => { followups++; },
    onComplete: async () => { await gate; },
  });
  await mgr.start("chat-1", "first", { kind: "user" });
  await mgr.start("chat-1", "second", { kind: "user" });
  turnEnd();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(followups, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(followups, 2);
});

test("RunManager: forwards cancellation to the host", async () => {
  let cancelled = false;
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "s1", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => {},
    onCancel: () => { cancelled = true; },
  });
  await mgr.start("chat-1", "hello", { kind: "user" });
  mgr.cancel("chat-1");
  assert.equal(cancelled, true);
});


test("RunManager: disposes a handle that arrives during disposeAll", async () => {
  let resolveAgent;
  let disposed = false;
  let followups = 0;
  const handle = { dispose: async () => { disposed = true; } };
  const mgr = new RunManager({
    resolveAgent: () => new Promise((resolve) => { resolveAgent = () => resolve({ agent: { id: "a" }, sessionId: "s1", handle }); }),
    buildMessage: () => ({ id: "m" }),
    subscribe: () => () => {},
    followup: () => { followups++; },
  });
  const starting = mgr.start("chat-1", "hello", { kind: "user" });
  await mgr.disposeAll();
  resolveAgent();
  await assert.rejects(() => starting, /disposed/);
  assert.equal(disposed, true);
  assert.equal(followups, 0);
});


test("RunManager: queues new messages during asynchronous completion", async () => {
  let turnEnd;
  let followups = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mgr = new RunManager({
    resolveAgent: async () => ({ agent: { id: "a" }, sessionId: "s1", handle: null }),
    buildMessage: () => ({ id: "m" }),
    subscribe: (agent, sessionId, onDelta, onTurnEnd) => {
      turnEnd = onTurnEnd;
      return () => {};
    },
    followup: () => { followups++; },
    onComplete: async () => { await gate; },
  });
  await mgr.start("chat-1", "first", { kind: "user" });
  turnEnd();
  await mgr.start("chat-1", "during-completion", { kind: "user" });
  assert.equal(followups, 1);
  assert.equal(mgr.getSlot("chat-1").pending.length, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(followups, 2);
});
