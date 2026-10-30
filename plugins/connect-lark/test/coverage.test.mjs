import { test } from "node:test";
import assert from "node:assert/strict";
import { passesWhitelist, downloadInboundImage, MAX_IMAGE_BYTES, RunManager, resolveAgentModelOptions, createOrResumeAgent, fetchDirectoryUsers, listDirectoryUsers, startDirectoryService } from "../lib/index.mjs";


// ---- passesWhitelist ----

test("passesWhitelist: app scope defers to the Feishu app availability scope", () => {
  const plain = { accessMode: "app", openId: "", senderAllowlist: [], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_1", "p2p"), true);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_1", "group"), true);
});

test("passesWhitelist: legacy open mode keeps the permissive behaviour", () => {
  const plain = { accessMode: "open", openId: "", senderAllowlist: [], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_1", "p2p"), true);
});

test("passesWhitelist: list mode denies anyone not granted", () => {
  const plain = { accessMode: "list", openId: "", senderAllowlist: ["ou_allowed"], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_allowed", "p2p"), true);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_other", "p2p"), false);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_other", "group"), false);
});

test("passesWhitelist: list mode always allows the tenant manager", () => {
  const plain = { accessMode: "list", openId: "", senderAllowlist: [], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_manager", "p2p", "ou_manager"), true);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_other", "p2p", "ou_manager"), false);
});

test("passesWhitelist: list mode honours the openId field", () => {
  const plain = { accessMode: "list", openId: "ou_owner", senderAllowlist: [], groupAllowlist: [] };
  assert.equal(passesWhitelist(plain, "chat-1", "ou_owner", "p2p"), true);
  assert.equal(passesWhitelist(plain, "chat-1", "ou_other", "p2p"), false);
});

test("passesWhitelist: list mode gates groups by the group allowlist", () => {
  const plain = { accessMode: "list", openId: "", senderAllowlist: [], groupAllowlist: ["oc_allowed"] };
  assert.equal(passesWhitelist(plain, "oc_allowed", "ou_1", "group"), true);
  assert.equal(passesWhitelist(plain, "oc_other", "ou_1", "group"), false);
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


// ---- 授权用户目录 ----

test("fetchDirectoryUsers: marks the tenant manager and lists users", async () => {
  const client = {
    contact: { v3: { user: { findByDepartment: async () => ({
      code: 0,
      data: { items: [
        { name: "陈鑫", open_id: "ou_owner", is_tenant_manager: true, email: "a@b.c" },
        { name: "李四", open_id: "ou_other", is_tenant_manager: false },
      ] },
    }) } } },
  };
  const result = await fetchDirectoryUsers(client);
  assert.equal(result.ok, true);
  assert.equal(result.users.length, 2);
  assert.equal(result.manager.openId, "ou_owner");
  assert.equal(result.manager.isManager, true);
  assert.equal(result.users[1].isManager, false);
});

test("fetchDirectoryUsers: reports permission failures without throwing", async () => {
  const client = {
    contact: { v3: { user: { findByDepartment: async () => ({ code: 99992402, msg: "field validation failed" }) } } },
  };
  const result = await fetchDirectoryUsers(client);
  assert.equal(result.ok, false);
  assert.match(result.reason, /field validation/);
  assert.equal(result.users.length, 0);
});

test("fetchDirectoryUsers: survives a thrown SDK error", async () => {
  const client = {
    contact: { v3: { user: { findByDepartment: async () => { throw new Error("network down"); } } } },
  };
  const result = await fetchDirectoryUsers(client);
  assert.equal(result.ok, false);
  assert.match(result.reason, /network down/);
});

test("listDirectoryUsers: rejects a non-zero Feishu code", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 99992402, msg: "no permission" }) });
  const result = await listDirectoryUsers("token", fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no permission/);
});

test("directory service serves the user list over loopback", async () => {
  const service = await startDirectoryService({
    listUsers: async () => ({ ok: true, users: [{ name: "陈鑫", openId: "ou_owner", isManager: true }], manager: { name: "陈鑫", openId: "ou_owner", isManager: true } }),
    port: 0,
  });
  try {
    const response = await fetch("http://127.0.0.1:" + service.port + "/lark-api/users");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.manager.openId, "ou_owner");
  } finally {
    await service.close();
  }
});

test("directory service rejects unknown paths", async () => {
  const service = await startDirectoryService({ listUsers: async () => ({ ok: true, users: [] }), port: 0 });
  try {
    const response = await fetch("http://127.0.0.1:" + service.port + "/other");
    assert.equal(response.status, 404);
  } finally {
    await service.close();
  }
});



