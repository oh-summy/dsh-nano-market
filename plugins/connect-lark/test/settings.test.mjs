import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// 动态 import：必须在 registerHooks 之后，channel stub 才生效
const lib = await import("../lib/index.mjs");
const {
  cwdTag, buildSettingsPanel, buildHistoryCard, buildApprovalCard, buildApprovalFinalCard,
  settingsStatusLine, modelOptions, effortOptions, currentModelValue,
} = lib;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// 假 profile 目录 + patch 文件（插件持久化配置的落点）——每个 harness 独立
function makePatchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-lark-profile-"));
  const file = path.join(dir, "cordis.patch.yml");
  fs.writeFileSync(file, [
    "- id: connect-lark",
    "  name: \"@oh-summy/connect-lark\"",
    "  config:",
    "    appId: cli_test",
    "    provider: agnes",
    "    model: agnes-3.0-flash",
    '    reasoningEffort: ""',
    "    permissionPreset: workspace-write",
    '    defaultPath: ""',
    "- id: other-plugin",
    "  name: \"@example/other\"",
    "",
  ].join("\n"));
  return { dir, file };
}
// 假 per-chat 状态文件（一等公民维度的持久化落点 connect-lark-sessions.json）——每个 harness 独立
function makeStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-lark-state-"));
  const file = path.join(dir, "connect-lark-sessions.json");
  fs.writeFileSync(file, "{}");
  return { dir, file };
}

test("cwdTag: stable, empty-safe", () => {
  assert.equal(cwdTag(""), "");
  assert.equal(cwdTag("/tmp/a"), cwdTag("/tmp/a"));
  assert.notEqual(cwdTag("/tmp/a"), cwdTag("/tmp/b"));
});

// ============ settings card builders ============

const catalog = {
  default: { provider: "kimi", model: "k3.1-pro" },
  groups: [{
    id: "kimi", name: "Kimi",
    models: [{
      id: "k3.1-pro", name: "K3.1 Pro",
      reasoning: { efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "low" },
    }, {
      id: "k3.1-mini", name: "K3.1 Mini",
    }],
  }],
};
const workspaces = [{ id: "ws-a", title: "项目A", path: "/tmp/a" }, { id: "ws-b", title: "项目B", path: "/tmp/b" }];
const permissions = [
  { value: "read-only", name: "仅可查看" },
  { value: "workspace-write", name: "工作区内修改" },
];

test("settingsStatusLine: empty, configured, attach-gui", () => {
  assert.equal(settingsStatusLine(undefined, false), "⚙️ 模型 / 强度 / 权限 / 工作区：跟随 DSH 默认");
  assert.equal(settingsStatusLine({ workspace: "项目A", model: "k3.1-pro", effort: "high", permission: "工作区内修改" }, false), "⚙️ 工作区 项目A · 模型 k3.1-pro · 强度 high · 权限 工作区内修改");
  assert.match(settingsStatusLine(undefined, true), /attach-gui/);
});

// 面板里的 select 收集助手：面板本身可能是整张卡（tag=collapsible_panel）或卡内的面板元素
function panelSelects(card) {
  const panel = card.tag === "collapsible_panel"
    ? card
    : (card.body?.elements ?? []).find((e) => e.tag === "collapsible_panel" && String(e.header?.title?.content || "").startsWith("⚙️"));
  assert.ok(panel, "panel exists");
  const out = [];
  for (const el of panel.elements ?? []) {
    if (el.tag === "select_static") out.push(el);
    if (el.tag === "column_set") for (const col of el.columns ?? []) for (const sub of col.elements ?? []) if (sub.tag === "select_static") out.push(sub);
  }
  return out;
}

test("buildSettingsPanel: four named select_static elements with grouped layout", () => {
  const card = buildSettingsPanel({ catalog, workspaces, permissions, defaultPermission: "workspace-write" });
  assert.equal(card.tag, "collapsible_panel");
  assert.equal(card.expanded, false, "panel collapsed by default");
  const selects = panelSelects(card);
  assert.deepEqual(selects.map((s) => s.name), ["model", "effort", "workspace", "permission"], "grouped row order");
  assert.ok(selects.every((s) => s.behaviors?.[0]?.type === "callback"), "every select carries a callback behavior (official-recommended custom回传参数)");
  assert.ok(selects.every((s) => Array.isArray(s.options) && s.options.length > 0), "no empty options selects");
  const workspace = selects.find((s) => s.name === "workspace");
  const model = selects.find((s) => s.name === "model");
  const effort = selects.find((s) => s.name === "effort");
  const permission = selects.find((s) => s.name === "permission");
  assert.ok(workspace.options.some((o) => o.value === "ws-b"), "workspace options list the registry");
  assert.ok(model.options.some((o) => o.value === "kimi:k3.1-pro"), "model value = provider:model");
  assert.ok(model.options[0].value === "__default__", "model list starts with 跟随 DSH 默认");
  assert.ok(effort.options.some((o) => o.value === "high"), "effort options follow the model");
  assert.ok(permission.options.some((o) => o.value === "__default__"), "default-preset option offered");
});

test("buildSettingsPanel: current values become initial_option", () => {
  const card = buildSettingsPanel({
    catalog, workspaces, permissions, defaultPermission: "workspace-write",
    current: { workspaceId: "ws-b", provider: "kimi", model: "k3.1-pro", reasoningEffort: "high", permission: "read-only" },
  });
  const selects = panelSelects(card);
  assert.equal(selects.find((s) => s.name === "workspace").initial_option, "ws-b");
  assert.equal(selects.find((s) => s.name === "model").initial_option, "kimi:k3.1-pro");
  assert.equal(selects.find((s) => s.name === "effort").initial_option, "high");
  assert.equal(selects.find((s) => s.name === "permission").initial_option, "read-only");
});

test("buildSettingsPanel: pending permission shows confirm hint", () => {
  const card = buildSettingsPanel({ catalog, workspaces, permissions, hasPendingPermission: true });
  assert.match(JSON.stringify(card.elements), /确认/);
});

test("modelOptions flattens provider groups; effortOptions follow the current model", () => {
  const opts = modelOptions(catalog);
  assert.deepEqual(opts, [
    { label: "Kimi · K3.1 Pro", value: "kimi:k3.1-pro" },
    { label: "Kimi · K3.1 Mini", value: "kimi:k3.1-mini" },
  ]);
  const efforts = effortOptions("kimi:k3.1-pro", catalog);
  assert.deepEqual(efforts.map((e) => e.value), ["__default__", "low", "high"]);
  assert.deepEqual(currentModelValue({ provider: "kimi", model: "k3.1-pro" }, catalog), "kimi:k3.1-pro");
  assert.deepEqual(currentModelValue(undefined, catalog), "kimi:k3.1-pro", "default route is the current route");
});

// ============ apply 集成（cardAction 流程） ============

async function makeSettingsHarness({ ownedPerChat = true, accessMode = "app", senderAllowlist = [], resolveAgentReturnsAgent = false, catalog: catalogOverride, defaultPermission = "workspace-write", persistFails = false, historySessions = [], historyTitleOf = (sid) => sid } = {}) {
  const calls = { sends: [], cards: [], selects: [], presetSets: [], disposes: [], followups: [], resolveSessions: [], registered: [], updates: [], creates: [], sessionCreates: [], boots: 0, configEditorEdits: 0, createSeq: 0, prepended: [] };
  // per-chat 状态文件（一等公民维度的持久化落点）——插件经 CONNECT_LARK_SESSION_MAP 指向这里
  const stateFile = makeStateFile();
  process.env.CONNECT_LARK_SESSION_MAP = stateFile.file;
  const readState = () => fs.readFileSync(stateFile.file, "utf8");
  // 一等公民改造后：卡片切换【不再】写插件配置（configEditor），而是写会话投影 + per-chat 状态文件。
  // configEditor spy 只用于断言「确实没有触碰配置」；persistFails → 让 agent 创建失败以模拟投影写失败。
  const failAgentCreate = persistFails;
  const channelHandlers = new Map();
  const handlers = new Map();
  const agent = {
    session: { id: "session-test" },
    followup(message) { calls.followups.push(message); },
    model: { select(sel) { calls.selects.push(sel); } },
    ctx: { tools: { register(tool) { calls.registered.push(tool); } } },
  };
  const createHandle = { dispose: async () => { calls.disposes.push(1); } };
  let disposer;
  const ctx = {
    logger: { info: (m) => console.log("[info]", m), warn: (m) => console.log("[warn]", m), error: (m) => console.log("[error]", m) },
    credentials: { resolve: async () => ({ value: "test-secret" }) },
    effect(fn) { disposer = fn(); },
    on(name, fn, options) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      // 记录 prepend 选项（waterfall 顺序语义）——供测试断言
      if (options && typeof options === "object" && options.prepend) {
        calls.prepended.push(name);
      }
      return () => handlers.get(name)?.delete(fn);
    },
    sessionController: {
      resolveAgent: async (sid) => { calls.resolveSessions.push(sid); return resolveAgentReturnsAgent ? { agent } : {}; },
      modelCatalog: async () => catalogOverride ?? catalog,
      cancel: async () => {},
      // P4：历史会话列表 / 新会话创建（mock 默认返回空列表 / 生成确定性 id）
      list: async () => ({ items: historySessions ?? [] }),
      create: async (req) => { calls.sessionCreates.push(req); return { sessionId: "host-uuid-" + (++calls.createSeq) }; },
      rename: async () => {},
    },
    workspaceRegistry: { list: () => workspaces },
    agents: { get: () => (ownedPerChat ? undefined : agent), create: async (opts) => { calls.creates.push(opts); if (failAgentCreate) throw new Error("simulated session-create failure"); return { agent, dispose: createHandle.dispose }; }, resume: async (opts) => { calls.creates.push(opts); if (failAgentCreate) throw new Error("simulated session-resume failure"); return { agent, dispose: createHandle.dispose }; } },
    permissionPresets: {
      set(session, name) { calls.presetSets.push({ session, name }); },
      catalog: () => ({ options: permissions, defaultPreset: defaultPermission }),
    },
    attachments: { saveImages: async () => [{ id: "img-1" }] },
    llm: { resolveModelInfo: async () => ({ inputModalities: ["text"], reasoning: { efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "low" } }) },
    // 一等公民改造后：configEditor 只用于断言「插件确实没碰配置」——真调 edit 就计数 + 抛错
    get(key) {
      if (key === "sessionQuery") {
        return {
          // 冷读会话标题（真机 root cause：rc.2 的 sessionListMetadata 只有 {blank, lastPromptAt}）
          readSession: async (sid) => ({
            events: [{ type: "session/title", data: { title: historyTitleOf(sid) } }],
          }),
        };
      }
      if (key === "profileContext") return { dir: stateFile.dir };
      if (key === "configEditor") {
        return {
          async edit() {
            calls.configEditorEdits++;
            throw new Error("configEditor.edit must NOT be called (first-class: no config writes)");
          },
        };
      }
      return undefined;
    },
    fiber: { entry: { options: { id: "connect-lark", name: "@oh-summy/connect-lark" } } },
  };
  const config = {
    appId: "cli_test", appSecretRef: "CONNECT_LARK_TEST", defaultPath: "", openId: "",
    accessMode,
    domain: "feishu", requireMention: true,
    agentOwnership: ownedPerChat ? "owned-per-chat" : "attach-gui",
    attachSessionId: "session-test", provider: "", model: "", permissionPreset: "",
    senderAllowlist, groupAllowlist: [], thinkingPolicy: "cot-visible",
  };
  globalThis.__connectLarkTestChannel = {
    create() {
      return {
        async connect() {},
        async disconnect() {},
        on(name, fn) { channelHandlers.set(name, fn); return () => channelHandlers.delete(name); },
        async send(chatId, input) { calls.sends.push({ chatId, input }); return { messageId: "msg-" + calls.sends.length }; },
        async updateCard(messageId, card) { calls.updates.push({ messageId, card }); },
        async stream(chatId, input) {
          const controller = { async update(card) { calls.cards.push(card); } };
          await input.card.producer(controller);
        },
        rawClient: { contact: { v3: { user: { findByDepartment: async () => ({ code: 0, data: { items: [] } }) } } } },
      };
    },
  };
  const emit = (name, ...args) => { let last; for (const fn of handlers.get(name) ?? []) last = fn(...args); return last; };
  const { apply } = await import("../lib/index.mjs");
  apply(ctx, config);
  await settle();
  // 模拟 DSH 重启：dispose + 重新 apply → 插件从 per-chat 状态文件重新 load（真机路径：重启不丢）
  const reloadPlugin = async () => {
    await disposer?.();
    disposer = undefined;
    calls.boots++;
    apply(ctx, config);
    await settle();
  };
  return {
    calls, agent,
    reloadPlugin,
    // 等 per-chat 状态文件落地（applyDimState 同步写，但保险起见轮询）
    async waitForState(match) {
      for (let i = 0; i < 60; i++) {
        if (readState().includes(match)) return true;
        await settle();
      }
      return false;
    },
    readState,
    cardAction: async (evt) => {
      console.log("[probe]", new Date().toISOString().slice(11, 23), "cardAction called:", JSON.stringify(evt.action));
      const fn = channelHandlers.get("cardAction");
      if (typeof fn !== "function") { console.log("[probe]", "cardAction handler MISSING"); return undefined; }
      const t0 = Date.now();
      const result = await fn(evt);
      console.log("[probe]", new Date().toISOString().slice(11, 23), "cardAction resolved in", Date.now() - t0, "ms");
      return result;
    },
    message: async (msg) => {
      const fn = channelHandlers.get("message");
      if (typeof fn !== "function") { console.log("[probe]", "message handler MISSING"); return; }
      return fn(msg);
    },
    emit,
    async endTurn() {
      const sid = calls.resolveSessions.at(-1) ?? "session-test";
      emit("session/event", { id: sid }, { type: "turn/end" });
      await settle();
    },
    async dispose() { await disposer?.(); delete globalThis.__connectLarkTestChannel; delete process.env.CONNECT_LARK_SESSION_MAP; },
  };
}

test("apply: model select rebuilds the reply card in place (no separate card)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn(); // 终稿卡片（含内嵌设置面板）已构建并存入 lastReplyCards
    const before = h.calls.cards.at(-1);
    const panelBefore = before.body.elements.find((e) => e.tag === "collapsible_panel" && String(e.header?.title?.content || "").startsWith("⚙️"));
    assert.ok(panelBefore, "finished reply card embeds the settings panel");
    const beforeSelects = [];
    for (const el of panelBefore.elements) {
      if (el.tag === "column_set") for (const col of el.columns ?? []) for (const sub of col.elements ?? []) if (sub.tag === "select_static") beforeSelects.push(sub);
      if (el.tag === "select_static") beforeSelects.push(sub);
    }
    assert.equal(beforeSelects.length, 4, "panel carries the four selects (nested in column groups)");

    // 从回复卡内嵌面板选模型 → 就地重建同一张卡（不弹新卡）
    // 回归锁定（真机 bug 2026-11-14）：CardKit 2.0 select_static 回调可能不带 action.name——
    // behaviors 自定义回传参数 { value: 控件名 } 必须兜底识别
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { option: "kimi:k3.1-pro", value: { value: "model" } } });
    assert.ok(resp.toast, "immediate toast returned");
    assert.match(resp.toast.content, /模型已切换/, "A→B switch toast");
    assert.match(resp.toast.content, /跟随 DSH 默认 → Kimi · K3.1 Pro/);
    await settle();
    assert.ok(!h.calls.sends.some((s) => s.input && s.input.card), "no separate card message sent");
  } finally { await h.dispose(); }
});

test("apply: attach-gui finished reply card has no settings panel (P0-1)", async () => {
  const h = await makeSettingsHarness({ ownedPerChat: false });
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    const finalCard = h.calls.cards.at(-1);
    const json = JSON.stringify(finalCard);
    assert.ok(!json.includes("快捷设置"), "no settings panel in attach-gui");
    assert.match(json, /attach-gui/, "status line explains why");
  } finally { await h.dispose(); }
});

test("apply: model select writes the session projection + per-chat state (NOT config)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 选模型 → 写会话投影（agent.model.select）+ per-chat 状态，绝不写配置
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    assert.ok(resp.toast, "immediate toast returned");
    assert.match(resp.toast.content, /本对话/, "toast is conversation-scoped (not plugin-global)");
    await h.waitForState('"provider": "kimi"');
    assert.match(h.readState(), /"provider":\s*"kimi"/, "per-chat state records the provider");
    assert.match(h.readState(), /"model":\s*"k3.1-pro"/, "per-chat state records the model");
    await settle();
    assert.ok(h.calls.selects.some((s) => s.provider === "kimi" && s.model === "k3.1-pro"), "agent.model.select wrote the session projection");
    assert.equal(h.calls.configEditorEdits, 0, "configEditor NEVER called (first-class: no config write, no HMR)");
    // 重启：per-chat 状态文件恢复该 chat 的显式选择（会话日志的 model/selection 由宿主重放）
    await h.reloadPlugin();
    assert.match(h.readState(), /"model":\s*"k3.1-pro"/, "choice survives a restart via the state file");
  } finally { await h.dispose(); }
});

test("apply: workspace switch updates defaultPath, disposes old handle, rebuilds on next turn", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    h.calls.disposes.length = 0;
    // 切工作区 → 修改插件配置 defaultPath + 就地重建回复卡
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "workspace", option: "ws-b" } });
    assert.ok(resp.toast, "immediate toast returned");
    await settle();
    await h.waitForState('"cwd": "/tmp/b"');
    assert.match(h.readState(), /"cwd": "\/tmp\/b"/, "per-chat state records the new workspace cwd");
    await settle();
    const notice = h.calls.sends.find((s) => typeof s.input === "object" && s.input.markdown && /已切换到工作区/.test(s.input.markdown));
    assert.ok(notice, "workspace switch notice sent");
    assert.match(notice.input.markdown, /下一条消息起/);
    // 下一条消息：旧 handle 被 dispose，重建（idle 路径）；新会话出身 = 新工作区
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "next" });
    await h.endTurn();
    assert.equal(h.calls.disposes.length, 1, "old handle disposed on workspace switch (idle path)");
    assert.equal(h.calls.creates.at(-1).meta.cwd, "/tmp/b", "fresh session born in the new workspace");
  } finally { await h.dispose(); }
});

test("apply: high permission requires confirm from the initiator only (P1-3)", async () => {
  const h = await makeSettingsHarness();
  try {
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "permission", option: "danger-full-access" } });
    assert.equal(resp.toast.type, "warning", "pending confirm toast");
    assert.match(resp.toast.content, /确认/);
    // 他人回复「确认」→ 不应用
    await h.message({ chatId: "oc-1", senderId: "ou-2", chatType: "p2p", messageId: "m-x", content: "确认" });
    await settle();
    assert.equal(h.calls.presetSets.length, 0, "non-initiator confirm ignored");
    // 发起人回复「确认」→ 写插件配置 + 回执
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m-y", content: "确认" });
    await settle();
    assert.match(JSON.stringify(h.calls.sends), /已应用权限/);
    await h.waitForState('"permissionPreset": "danger-full-access"');
    assert.match(h.readState(), /"permissionPreset": "danger-full-access"/, "choice persisted to per-chat state (not config)");
    // 下一轮 createOrResumeAgent 把 permission 设到会话
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m3", content: "go" });
    assert.equal(h.calls.presetSets.length, 1, "permission applied to session on next run");
    assert.equal(h.calls.presetSets[0].name, "danger-full-access");
  } finally { await h.dispose(); }
});

test("apply: running-turn card action hot-applies without disturbing the turn (P0-2)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    const createsBefore = h.calls.creates.length;
    // m1 进行中（未 turn/end）：点模型 → 热应用（fiber.update 立即提交，无重连）
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    assert.match(resp.toast.content, /已切换/, "immediate A→B toast");
    await h.waitForState('"model": "k3.1-pro"');
    assert.match(h.readState(), /"model": "k3.1-pro"/, "choice written to per-chat state");
    assert.equal(h.calls.creates.length, createsBefore, "in-flight turn untouched (no new agent mid-turn)");
    // turn/end 后下一条消息 → resolveAgent 指纹检测 → 新 agent 用新模型
    await h.endTurn();
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "next" });
    await h.endTurn();
    assert.ok(h.calls.selects.some((s) => s.provider === "kimi" && s.model === "k3.1-pro"), "new model reached the session via projection");
    assert.equal(h.calls.creates.at(-1).agentOptions.provider, undefined, "no model force-pushed into agentOptions (first-class)");
  } finally { await h.dispose(); }
});

test("apply: changing model clears a stale effort (DSH may reject unsupported effort)", async () => {
  const catalog2 = {
    default: { provider: "kimi", model: "k3.1-pro" },
    groups: [{
      id: "kimi", name: "Kimi",
      models: [
        { id: "k3.1-pro", name: "K3.1 Pro", reasoning: { efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "low" } },
        { id: "k3.1-mini", name: "K3.1 Mini" },
      ],
    }],
  };
  const h = await makeSettingsHarness({ catalog: catalog2 });
  try {
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    await h.cardAction({ chatId: "oc-1", messageId: "card-2", operator: { openId: "ou-1" }, action: { name: "effort", option: "high" } });
    // 换模型 B（无 efforts）→ effort 应被清除，不留残留
    await h.cardAction({ chatId: "oc-1", messageId: "card-3", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-mini" } });
    await settle();
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    await h.waitForState('"model": "k3.1-mini"');
    const state = h.readState();
    assert.match(state, /"model": "k3.1-mini"/, "model switch recorded in per-chat state");
    assert.ok(!state.includes('"reasoningEffort"'), "stale effort cleared on model change (no leftover effort for k3.1-mini)");
    await h.reloadPlugin();
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "next" });
    await h.endTurn();
    // 模型走会话投影（agent.model.select），不再走 agentOptions（无 force-push）
    assert.deepEqual(h.calls.creates.at(-1).agentOptions, {}, "no config/model force-push into agentOptions (first-class)");
    assert.ok(h.calls.selects.some((s) => s.model === "k3.1-mini" && !s.reasoningEffort), "no stale effort carried via the session projection");
  } finally { await h.dispose(); }
});

test("apply: selecting a normal permission cancels a pending high-permission confirm", async () => {
  const h = await makeSettingsHarness();
  try {
    // 高权限 → pending
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "permission", option: "danger-full-access" } });
    // 改选普通权限 → pending 清除 + 配置立即更新为 read-only
    await h.cardAction({ chatId: "oc-1", messageId: "card-2", operator: { openId: "ou-1" }, action: { name: "permission", option: "read-only" } });
    await h.waitForState('"permissionPreset": "read-only"');
    assert.match(h.readState(), /"permissionPreset": "read-only"/);
    // 发起人回复「确认」→ 无 pending，不应用
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "确认" });
    await settle();
    assert.match(JSON.stringify(h.calls.sends), /没有待确认的设置/);
    // 下一轮：应用的是 read-only 而非 danger-full-access
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "go" });
    await h.endTurn();
    assert.equal(h.calls.presetSets.length, 1);
    assert.equal(h.calls.presetSets[0].name, "read-only");
  } finally { await h.dispose(); }
});

test("apply: permission __default__ resolves to the DSH default preset", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m0", content: "warm up" });
    await h.endTurn(); // onComplete 刷新 settingsData（defaultPermission 就位）
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "permission", option: "__default__" } });
    await h.waitForState('"permissionPreset": "workspace-write"');
    assert.match(h.readState(), /"permissionPreset": "workspace-write"/, "__default__ resolves to the catalog defaultPreset");
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "go" });
    await h.endTurn();
    assert.equal(h.calls.presetSets.length, 1);
    assert.equal(h.calls.presetSets[0].name, "workspace-write", "defaultPreset from the catalog is applied");
  } finally { await h.dispose(); }
});

test("buildSettingsPanel: empty permission catalog still yields a selectable option", () => {
  const card = buildSettingsPanel({ catalog, workspaces, permissions: [], defaultPermission: "" });
  const perm = panelSelects(card).find((s) => s.name === "permission");
  assert.ok(perm.options.length > 0, "permission select must never be empty (Feishu rejects empty options)");
});

test("apply: effort options follow the model just selected (not the previous one)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 选 MiniMax（其 catalog 档位为 low/medium/high）→ 面板就地更新，强度档位跟随新模型
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-mini" } });
    assert.ok(resp.card, "model select updates the card in place");
    const panel = resp.card.data.body.elements.find((e) => e.tag === "collapsible_panel" && String(e.header?.title?.content || "").startsWith("⚙️"));
    const selects = panel.elements
      .filter((e) => e.tag === "column_set").flatMap((cs) => (cs.columns ?? []).flatMap((c) => c.elements ?? []))
      .filter((e) => e.tag === "select_static");
    const effort = selects.find((e) => e.name === "effort");
    const values = effort.options.map((o) => o.value);
    assert.ok(values.includes("__default__"), "default option present");
    // k3.1-mini 在 catalog 里没有 reasoning.efforts → 只有默认档；k3.1-pro 才有 low/high
    assert.deepEqual(values, ["__default__"], "effort options belong to the newly selected model");
    const model = selects.find((e) => e.name === "model");
    assert.equal(model.initial_option, "kimi:k3.1-mini", "model select reflects the new model");
  } finally { await h.dispose(); }
});

test("apply: effort not supported by the current model is rejected", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 当前模型 kimi:k3.1-pro 支持 low/high；"max" 不支持 → 拒绝
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "effort", option: "max" } });
    assert.equal(resp.toast.type, "error");
    assert.match(resp.toast.content, /不支持/);
  } finally { await h.dispose(); }
});

test("apply: high permission cannot be reached via the DSH default preset (P0-2)", async () => {
  const h = await makeSettingsHarness({ defaultPermission: "danger-full-access" });
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 选「设为 DSH 默认预设」→ 默认预设本身是 danger-full-access → 必须走二次确认
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "permission", option: "__default__" } });
    assert.equal(resp.toast.type, "warning", "default preset that resolves to a high-permission preset still needs confirmation");
    assert.match(resp.toast.content, /确认/);
    assert.doesNotMatch(h.readState(), /"permissionPreset": "danger-full-access"/, "not applied to the session before confirmation");
  } finally { await h.dispose(); }
});

test("apply: a failed persist is reported instead of claiming success (P1-4)", async () => {
  const h = await makeSettingsHarness({ persistFails: true });
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    await settle();
    const notified = h.calls.sends.some((s) => s.input && typeof s.input.markdown === "string" && /未保存|失败/.test(s.input.markdown));
    assert.ok(notified, "the user is told the setting was not saved");
  } finally { await h.dispose(); }
});

test("apply: settings in one chat never touch another chat's card (P1-1)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-a", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello A" });
    await h.endTurn();
    await h.message({ chatId: "oc-b", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "hello B" });
    await h.endTurn();
    const cardB = h.calls.cards.at(-1);
    const before = JSON.stringify(cardB);
    // 在 A 聊天操作 → B 的卡片不得变化
    await h.cardAction({ chatId: "oc-a", messageId: "card-a", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    await settle();
    assert.equal(JSON.stringify(cardB), before, "chat B's stored card is untouched");
  } finally { await h.dispose(); }
});

test("buildSettingsPanel: initial_option is only set when it exists in options (P2-6)", () => {
  const card = buildSettingsPanel({
    catalog, workspaces, permissions, defaultPermission: "workspace-write",
    current: { provider: "unknown", model: "not-in-catalog", reasoningEffort: "high" },
  });
  const selects = panelSelects(card);
  for (const s of selects) {
    if (s.initial_option !== undefined) {
      assert.ok(s.options.some((o) => o.value === s.initial_option), "initial_option must exist in options");
    }
  }
});

test("apply: DSH service-layer config is never touched by card settings (P1-6 / P0-1)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    await settle();
    assert.equal(h.calls.configEditorEdits, 0, "card settings never write the profile config (host's agent-default-model untouched)");
  } finally { await h.dispose(); }
});

test("apply: the auto preset does not require confirmation (it asks every call)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // auto = sandbox 全权 + approval ask（每次调用都审查）→ 比 danger-full-access（never）安全
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "permission", option: "auto" } });
    assert.equal(resp.toast.type, "success", "auto applies without a confirmation step");
    await h.waitForState('"permissionPreset": "auto"');
    assert.match(h.readState(), /"permissionPreset": "auto"/, "auto persisted to per-chat state");
  } finally { await h.dispose(); }
});

test("apply: picking an effort right after a model switch validates against the new model", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 先切到有档位的模型，紧接着选它的档位——持久化是异步的，
    // 校验必须用「配置 + 待写候选」的合并视图，不能按旧模型误拒
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-2", operator: { openId: "ou-1" }, action: { name: "effort", option: "high" } });
    assert.equal(resp.toast.type, "success", "effort of the just-selected model is accepted");
    await h.waitForState('"reasoningEffort": "high"');
    assert.match(h.readState(), /"reasoningEffort": "high"/, "effort persisted to per-chat state");
  } finally { await h.dispose(); }
});

test("apply: whitelist rejects cardAction in list mode (P1-3 鉴权)", async () => {
  const h = await makeSettingsHarness({ accessMode: "list", senderAllowlist: ["ou-ok"] });
  try {
    const denied = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-bad" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    assert.equal(denied.toast.type, "error");
    assert.match(denied.toast.content, /无权/);
    await settle();
    assert.ok(!h.calls.sends.some((s) => s.input && s.input.card), "no card sent for unauthorized operator");
  } finally { await h.dispose(); }
});

test("apply: feishu_send_media tool delivers images through the current bot", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    assert.equal(h.calls.registered.length, 1, "media tool registered once for the created agent");
    assert.equal(h.calls.registered[0].name, "feishu_send_media");
    const img = "/tmp/cl-test-image.png";
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const tool = h.calls.registered[0];
    const result = await tool.execute(
      { path: img, caption: "给你" },
      { agent: { session: { id: h.calls.resolveSessions.at(-1) } } },
    );
    assert.equal(result.ok, true, "tool reports success");
    assert.equal(result.kind, "image");
    const sent = h.calls.sends.find((s) => s.input && s.input.image);
    assert.ok(sent, "image delivered via send({ image })");
    assert.equal(sent.chatId, "oc-1", "sent to the current chat, not another app");
    assert.equal(sent.input.image.source, img);
    const caption = h.calls.sends.filter((s) => s.input && s.input.text);
    assert.ok(caption.at(-1), "caption sent as text message");
    assert.equal(caption.at(-1).input.text, "给你");
  } finally { await h.dispose(); }
});

test("apply: attach-gui agents get no media tool", async () => {
  const h = await makeSettingsHarness({ ownedPerChat: false });
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    assert.equal(h.calls.registered.length, 0, "no media tool on the shared GUI agent");
  } finally { await h.dispose(); }
});

test("apply: dedup swallows repeated card actions (60s TTL)", async () => {
  const h = await makeSettingsHarness();
  try {
    const evt = { chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } };
    const first = await h.cardAction(evt);
    const second = await h.cardAction(evt);
    assert.ok(first, "first applies");
    assert.equal(second, undefined, "same messageId+name+option deduped");
  } finally { await h.dispose(); }
});

test("apply: finished reply card carries status line and the inline settings panel", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 设置一个 override 让状态行有内容
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "model", option: "kimi:k3.1-pro" } });
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "again" });
    await h.endTurn();
    h.calls.cards.length = 0;
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m3", content: "third" });
    await h.endTurn();
    // 终稿卡片：header.subtitle 状态行 + 内嵌「⚙️ 快捷设置」折叠面板（带标签的四个下拉）
    const finalCard = h.calls.cards.at(-1);
    assert.ok(finalCard, "final card produced");
    const subtitle = String(finalCard.header?.subtitle?.content || "");
    assert.match(subtitle, /⚙️/, "status line lives in header subtitle");
    assert.match(subtitle, /Kimi · K3.1 Pro/, "subtitle shows the effective model");
    const panel = finalCard.body.elements.find((e) => e.tag === "collapsible_panel" && String(e.header?.title?.content || "").startsWith("⚙️"));
    assert.ok(panel, "inline settings panel embedded");
    assert.equal(panel.expanded, false, "panel collapsed by default");
    // 分组布局：面板内嵌 column_set（模型+思考强度一组、工作区+权限一组）
    const selects = [];
    for (const el of panel.elements) {
      if (el.tag === "column_set") for (const col of el.columns ?? []) for (const sub of col.elements ?? []) if (sub.tag === "select_static") selects.push(sub);
      if (el.tag === "select_static") selects.push(el);
    }
    assert.deepEqual(selects.map((s) => s.name), ["model", "effort", "workspace", "permission"], "grouped row order");
    assert.match(JSON.stringify(panel.elements), /\*\*模型\*\*/, "panel labels present above selects");
    const modelSel = selects.find((s) => s.name === "model");
    assert.equal(modelSel.initial_option, "kimi:k3.1-pro", "panel reflects the override");
    assert.ok(!finalCard.body.elements.some((e) => e.tag === "div" && String(e.text?.content || "").startsWith("⚙️")), "status line no longer inside body");
  } finally { await h.dispose(); }
});

// ============ P4：历史对话 / 新对话 ============

test("buildHistoryCard: lists sessions as select options with new-conversation + close buttons", () => {
  const sessions = [
    { sessionId: "sess-a", title: "对话A", cwd: "/tmp/a" },
    { sessionId: "sess-b", title: "对话B", cwd: "/tmp/b" },
  ];
  const card = buildHistoryCard(sessions, "sess-b");
  assert.equal(card.schema, "2.0");
  assert.equal(String(card.header?.title?.content), "🗂 历史对话");
  const sel = card.body.elements.find((e) => e.tag === "select_static");
  assert.ok(sel, "history select_static present");
  assert.equal(sel.name, "history");
  assert.deepEqual(sel.options.map((o) => o.value), ["sess-a", "sess-b"], "option values are session ids");
  assert.equal(sel.initial_option, "sess-b", "current session highlighted");
  const btns = card.body.elements.filter((e) => e.tag === "button");
  assert.equal(btns.length, 2, "new-conversation + close buttons");
  assert.equal(btns[0].behaviors[0].value.value, "new-conversation");
  assert.equal(btns[1].behaviors[0].value.value, "cancel-history");
});

test("buildHistoryCard: empty sessions renders a note, no invalid empty-value option", () => {
  const card = buildHistoryCard([]);
  const sel = card.body.elements.find((e) => e.tag === "select_static");
  assert.equal(sel, undefined, "no select when there is nothing to pick (empty option value is rejected by Feishu)");
  const txt = JSON.stringify(card.body.elements);
  assert.match(txt, /暂无历史会话/, "explains why there is no picker");
  // 非空时才有 select，且选项值都是 sessionId
  const card2 = buildHistoryCard([{ sessionId: "sess-a", title: "A" }]);
  const sel2 = card2.body.elements.find((e) => e.tag === "select_static");
  assert.ok(sel2, "select present with sessions");
  assert.deepEqual(sel2.options.map((o) => o.value), ["sess-a"]);
});

test("apply: open-history button sends a history card (P4)", async () => {
  const h = await makeSettingsHarness({ historySessions: [{ sessionId: "sess-a", title: "对话A" }] });
  try {
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { value: { value: "open-history" } } });
    assert.ok(resp?.toast, "toast returned immediately");
    await settle();
    const historySend = h.calls.sends.find((s) => s.input?.card && String(s.input.card.header?.title?.content || "").includes("历史对话"));
    assert.ok(historySend, "history card sent");
    const sel = historySend.input.card.body.elements.find((e) => e.tag === "select_static");
    assert.equal(sel.options[0].value, "sess-a", "session option carried");
  } finally { await h.dispose(); }
});

test("apply: history select switches the chat session (P4)", async () => {
  const h = await makeSettingsHarness({ historySessions: [{ sessionId: "sess-a", title: "对话A" }, { sessionId: "sess-b", title: "对话B" }] });
  try {
    // 先让插件为该 chat 建立默认会话（发一条消息走 resolveAgent）
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    // 从历史卡选 sess-b
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-2", operator: { openId: "ou-1" }, action: { name: "history", option: "sess-b" } });
    assert.ok(resp?.toast, "switch toast returned");
    assert.match(resp.toast.content, /历史对话/);
    // per-chat 状态记录新 sessionId
    const state = JSON.parse(h.readState());
    assert.equal(state["oc-1"].sessionId, "sess-b", "sessionId switched in per-chat state");
    // 下一条消息走新会话（resolveAgent 用新 id）
    h.calls.resolveSessions.length = 0;
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m2", content: "again" });
    await h.endTurn();
    assert.ok(h.calls.resolveSessions.includes("sess-b"), "next turn resolves the switched session");
  } finally { await h.dispose(); }
});

test("apply: history select rejects unknown session (P4)", async () => {
  const h = await makeSettingsHarness({ historySessions: [{ sessionId: "sess-a", title: "对话A" }] });
  try {
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { name: "history", option: "sess-ghost" } });
    assert.ok(resp?.toast?.type === "error", "unknown session rejected");
  } finally { await h.dispose(); }
});

test("apply: new-conversation button creates a host session and records it (P4)", async () => {
  const h = await makeSettingsHarness();
  try {
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { value: { value: "new-conversation" } } });
    assert.ok(resp?.toast, "toast returned");
    await settle();
    // 会话创建被调用，且 per-chat 状态记录了 host-uuid
    assert.ok(h.calls.sessionCreates.some((c) => c && typeof c === "object"), "sessionController.create called");
    const state = JSON.parse(h.readState());
    assert.ok(state["oc-1"].sessionId?.startsWith("host-uuid-"), "new session id recorded");
    // 下一条消息用新会话
    h.calls.resolveSessions.length = 0;
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    assert.ok(h.calls.resolveSessions.some((s) => s.startsWith("host-uuid-")), "next turn uses the new session");
  } finally { await h.dispose(); }
});

// ============ P5：审批终态 ============

test("buildApprovalCard: carries approve/reject buttons with callId", () => {
  const card = buildApprovalCard("write", "需要写文件", "call-123");
  assert.equal(String(card.header?.title?.content), "审批请求");
  const btns = card.body.elements.filter((e) => e.tag === "button");
  assert.equal(btns.length, 2);
  assert.equal(btns[0].behaviors[0].value.value, "approve:call-123");
  assert.equal(btns[1].behaviors[0].value.value, "reject:call-123");
});

test("buildApprovalFinalCard: terminal state replaces buttons with conclusion text", () => {
  const ok = buildApprovalFinalCard("write", "allowed-once");
  assert.match(String(ok.body.elements[0].text.content), /你已同意/);
  assert.ok(!ok.body.elements.some((e) => e.tag === "button"), "no buttons in final card");
  const rej = buildApprovalFinalCard("write", "rejected");
  assert.match(String(rej.body.elements[0].text.content), /你已拒绝/);
  const cancel = buildApprovalFinalCard("write", "cancelled");
  assert.match(String(cancel.body.elements[0].text.content), /已取消/);
});

test("apply: approval/request sends a card and resolves on approve click (P5)", async () => {
  const h = await makeSettingsHarness();
  try {
    // 先建立 sessionChat 归属：发一条消息让 resolveAgent 注册 sessionId → chatId
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    const sid = h.calls.resolveSessions.at(-1);
    assert.ok(sid, "session resolved");
    // 触发 approval/request，捕获 listener 返回的 Promise
    const approvalPromise = h.emit("approval/request", { agent: { session: { id: sid } }, toolName: "write", callId: "call-1", reason: "needs write" }, () => Promise.resolve("unavailable"));
    await settle();
    // 审批卡应已发出
    const approvalSend = h.calls.sends.find((s) => s.input?.card && String(s.input.card.header?.title?.content || "").includes("审批"));
    assert.ok(approvalSend, "approval card sent");
    // 点「同意」按钮
    const resp = await h.cardAction({ chatId: "oc-1", messageId: "approval-card", operator: { openId: "ou-1" }, action: { value: { value: "approve:call-1" } } });
    assert.ok(resp?.toast, "approve toast");
    assert.match(resp.toast.content, /已同意/);
    // 审批 Promise 应已 resolve 为 allowed-once
    const outcome = await approvalPromise;
    assert.equal(outcome, "allowed-once", "approval resolved with allowed-once");
    // 审批卡就地更新为终态（updateCard 被调用）
    await settle();
    assert.ok(h.calls.updates.length > 0, "approval card updated to terminal state");
    const finalUpdate = h.calls.updates.at(-1);
    assert.match(String(finalUpdate.card.body.elements[0].text.content), /你已同意/, "final card shows consent");
  } finally { await h.dispose(); }
});

test("apply: the approval listener is registered with prepend (waterfall order, P5)", async () => {
  // 回归锁定：approval/request 是 waterfall，宿主 Web answerer 注册更早且会挂起等人点，
  // 插件若不 prepend 就永远轮不到（真机实测：approval/asked 有、decided 无、飞书无审批卡）。
  const h = await makeSettingsHarness();
  try {
    assert.ok(h.calls.prepended.includes("approval/request"), "approval listener registered with prepend");
  } finally { await h.dispose(); }
});

test("apply: approval for a non-owned agent delegates via next() (P5)", async () => {
  const h = await makeSettingsHarness();
  try {
    // 不先发消息 → sessionChat 为空 → 审批应交给 next()
    let nextCalled = false;
    const outcome = await h.emit("approval/request", { agent: { session: { id: "unknown-session" } }, toolName: "write", callId: "call-x" }, () => { nextCalled = true; return Promise.resolve("rejected"); });
    assert.equal(outcome, "rejected", "next() result returned");
    assert.ok(nextCalled, "next() was called");
    assert.ok(!h.calls.sends.some((s) => s.input?.card && String(s.input.card.header?.title?.content || "").includes("审批")), "no approval card for non-owned agent");
  } finally { await h.dispose(); }
});

test("apply: history card options show real session titles, not raw ids", async () => {
  const h = await makeSettingsHarness({
    historySessions: [{ sessionId: "sess-a", title: "对话A" }],
    historyTitleOf: () => "请在 /tmp/dsh-approval-probe.txt 写",
  });
  try {
    await h.cardAction({ chatId: "oc-1", messageId: "card-1", operator: { openId: "ou-1" }, action: { value: { value: "open-history" } } });
    await settle();
    const historySend = h.calls.sends.find((s) => s.input?.card && String(s.input.card.header?.title?.content || "").includes("历史对话"));
    assert.ok(historySend, "history card sent");
    const sel = historySend.input.card.body.elements.find((e) => e.tag === "select_static");
    // 标题来自冷读的 session/title 事件（rc.2 的 list 行没有标题）
    assert.equal(sel.options[0].text.content, "请在 /tmp/dsh-approval-probe.txt 写", "real title from cold read");
  } finally { await h.dispose(); }
});

test("apply: settings panel carries history/new-conversation buttons (P4)", async () => {
  const h = await makeSettingsHarness();
  try {
    await h.message({ chatId: "oc-1", senderId: "ou-1", chatType: "p2p", messageId: "m1", content: "hello" });
    await h.endTurn();
    const finalCard = h.calls.cards.at(-1);
    const panel = finalCard.body.elements.find((e) => e.tag === "collapsible_panel" && String(e.header?.title?.content || "").startsWith("⚙️"));
    assert.ok(panel, "settings panel present");
    const btns = panel.elements.filter((e) => e.tag === "button");
    const values = btns.map((b) => b.behaviors?.[0]?.value?.value);
    assert.ok(values.includes("open-history"), "history button in panel");
    assert.ok(values.includes("new-conversation"), "new-conversation button in panel");
  } finally { await h.dispose(); }
});
