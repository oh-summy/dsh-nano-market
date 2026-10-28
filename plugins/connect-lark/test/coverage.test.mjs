import { test } from "node:test";
import assert from "node:assert/strict";
import { passesWhitelist, downloadInboundImage, MAX_IMAGE_BYTES, RunManager, resolveAgentModelOptions, createOrResumeAgent } from "../lib/index.mjs";

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

test("resolveAgentModelOptions: empty route inherits DSH default model and effort", () => {
  const catalog = {
    default: { provider: "kimi", model: "k3.1-pro", reasoningEffort: "high" },
    groups: [],
  };
  assert.deepEqual(resolveAgentModelOptions({ provider: "", model: "", reasoningEffort: "" }, catalog), {
    provider: "kimi", model: "k3.1-pro", reasoningEffort: "high",
  });
});

test("resolveAgentModelOptions: selected model inherits its own default effort", () => {
  const catalog = {
    default: { provider: "kimi", model: "k3.1-pro", reasoningEffort: "high" },
    groups: [{ id: "kimi", models: [{ id: "other", reasoning: { defaultEffort: "low", efforts: [] } }] }],
  };
  assert.deepEqual(resolveAgentModelOptions({ provider: "kimi", model: "other", reasoningEffort: "" }, catalog), {
    provider: "kimi", model: "other", reasoningEffort: "low",
  });
});

test("resolveAgentModelOptions: explicit effort wins", () => {
  const catalog = { default: { provider: "kimi", model: "k3.1-pro", reasoningEffort: "high" }, groups: [] };
  assert.deepEqual(resolveAgentModelOptions({ provider: "", model: "", reasoningEffort: "max" }, catalog), {
    provider: "kimi", model: "k3.1-pro", reasoningEffort: "max",
  });
});


test("createOrResumeAgent: reuses a live agent without creating", async () => {
  const live = { id: "live" };
  const ctx = { agents: { get: () => live, create: async () => { throw new Error("must not create"); } } };
  const result = await createOrResumeAgent(ctx, "session-live", { cwd: "/tmp" }, {});
  assert.equal(result.agent, live);
  assert.equal(result.handle, null);
});

test("createOrResumeAgent: resumes a persisted session on duplicate create", async () => {
  const resumed = { agent: { id: "resumed" }, dispose: async () => {} };
  const ctx = { agents: {
    get: () => undefined,
    create: async () => { throw new Error("session already exists"); },
    resume: async () => resumed,
  } };
  const result = await createOrResumeAgent(ctx, "session-existing", { cwd: "/tmp" }, {});
  assert.equal(result.agent, resumed.agent);
  assert.equal(result.handle, resumed);
});

test("createOrResumeAgent: rethrows unrelated create failures", async () => {
  const ctx = { agents: {
    get: () => undefined,
    create: async () => { throw new Error("provider unavailable"); },
    resume: async () => { throw new Error("must not resume"); },
  } };
  await assert.rejects(() => createOrResumeAgent(ctx, "session-new", {}, {}), /provider unavailable/);
});


test("createOrResumeAgent: applies a selected permission preset to the live agent", async () => {
  const live = { id: "live", session: { id: "session-live" } };
  const calls = [];
  const ctx = {
    agents: { get: () => live },
    permissionPresets: { set: (session, name) => calls.push([session.id, name]) },
  };
  await createOrResumeAgent(ctx, "session-live", {}, {}, "workspace-write");
  assert.deepEqual(calls, [["session-live", "workspace-write"]]);
});


test("createOrResumeAgent: retries active write handle and reuses the live agent", async () => {
  const live = { id: "live" };
  let gets = 0;
  let creates = 0;
  const ctx = { agents: {
    get: () => (++gets === 3 ? live : undefined),
    create: async () => { creates++; throw new Error("session is already owned by an active write handle"); },
  } };
  const result = await createOrResumeAgent(ctx, "session-live", {}, {});
  assert.equal(result.agent, live);
  assert.equal(result.handle, null);
  assert.equal(gets, 3);
  assert.equal(creates, 2);
});


test("createOrResumeAgent: prefers sessionController's live agent", async () => {
  const live = { id: "live", session: {} };
  const ctx = {
    sessionController: { resolveAgent: async () => ({ agent: live }) },
    agents: { get: () => { throw new Error("must not call get"); }, create: async () => { throw new Error("must not create"); } },
  };
  const result = await createOrResumeAgent(ctx, "session-live", {}, {});
  assert.equal(result.agent, live);
  assert.equal(result.sessionId, "session-live");
});

test("createOrResumeAgent: creates a fresh session when writer stays held", async () => {
  const created = { agent: { id: "fresh" }, dispose: async () => {} };
  const ctx = {
    sessionController: { resolveAgent: async () => ({ error: { code: "session/writer-held" } }) },
    agents: {
      get: () => undefined,
      create: async (options) => {
        if (options.sessionId === "session-live") throw new Error("active write handle");
        return created;
      },
      resume: async () => { throw new Error("active write handle"); },
    },
  };
  const result = await createOrResumeAgent(ctx, "session-live", {}, {});
  assert.equal(result.agent, created.agent);
  assert.equal(result.handle, created);
  assert.notEqual(result.sessionId, "session-live");
  assert.ok(result.sessionId.startsWith("session-live:"));
});
