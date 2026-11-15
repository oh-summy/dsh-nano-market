// @oh-summy/connect-lark — Feishu/Lark long-connection channel for DSH.
//
// Long connection + agent driving + streaming card replies + image handling.
// Core decisions:
//   - agent ownership: owned-per-chat by default; attach-gui remains an advanced option
//   - CoT policy: cot-visible by default (reasoning is shown in the rich card)
//   - access: allow everyone by default; optional per-chat-kind allowlists
//   - hot updates: appId/provider/model require reconnect; others are hot
//
// Architecture (ARCHITECTURE §10):
//   apply() -> parse config -> resolveAppSecret -> createLarkChannel -> connect()
//   -> channel.on("message") -> whitelist check -> start run -> stream reply
//   -> disposer: disconnect + dispose agents + clear slots
//
// Event names (verified against dsh-agent-loop): agent/assistant-stream,
//   session/event turn/start + turn/end, agent/error, agent/inbox/claimed.

import { stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createLarkChannel, type LarkChannel } from "@larksuite/channel";
import {
  buildApprovalCard, buildApprovalFinalCard, buildHistoryCard, buildSettingsPanel,
  CANCEL_SETTINGS_VALUE, currentModelValue, DEFAULT_OPTION_VALUE,
  effortOptions, modelOptions,
  richCard, settingsStatusLine, streamMarkdown,
  type HistorySessionOption, type SettingsCardOptions, type SettingsDisplay,
} from "./cards.js";
import { cwdTag } from "./overrides.js";
import { defaultStatePath, loadStates, saveStates, type ChatState, type ChatStateMap } from "./session-map.js";

// 进程级串行链：持久化配置的写入必须**全局**串行。
// 为什么不能放在 apply() 闭包或模块级变量里：
//   - 闭包：每个插件实例一条链 → 实例之间并发 → HMR 报「transactions cannot be nested」；
//   - 模块级变量：HMR 重载 entry 时会创建**新的模块命名空间**（旧实例的模块仍存活），
//     变量随之重新初始化 → 新旧实例的链仍然不共享 → 同样 nested（真机实证 2026-11-14 23:43）。
// globalThis 是进程级的，跨模块实例、跨 entry 重载都唯一。
import { RunManager, type RunSlot } from "./run.js";
import { fetchDirectory, fetchDirectoryUsers, type Directory } from "./users.js";
import { startDirectoryService, type DirectoryService } from "./directory-service.js";
import { admitImage, buildImageContent, IMAGE_UNSUPPORTED_REPLY, downloadImageBounded, downloadInboundImage, MAX_IMAGES_PER_MESSAGE } from "./images.js";

// ---- Config schema (schemastery, not plain zod — ARCHITECTURE §10.6) ----

export interface Config {
  enabled?: boolean;
  appId?: string;
  appSecretRef?: string;
  appSecretPreview?: string;
  defaultPath?: string;
  openId?: string;
  domain?: "feishu" | "lark";
  requireMention?: boolean;
  agentOwnership?: "owned-per-chat" | "attach-gui";
  attachSessionId?: string;
  provider?: string;
  model?: string;
  accessMode?: "app" | "list" | "open" | "restricted";
  senderAllowlist?: string[];
  groupAllowlist?: string[];
  thinkingPolicy?: "cot-visible" | "cot-discard" | "stream-only";
  reasoningEffort?: string;
  permissionPreset?: string;
}

type Vol<T> = T | { get(): T };

export type ParsedConfig = {
  [K in keyof Config]: Vol<NonNullable<Config[K]>>;
};

export type ResolvedConfig = {
  enabled: boolean;
  appId: string;
  appSecretRef: string;
  appSecretPreview: string;
  defaultPath: string;
  openId: string;
  domain: "feishu" | "lark";
  requireMention: boolean;
  agentOwnership: "owned-per-chat" | "attach-gui";
  attachSessionId: string;
  provider: string;
  model: string;
  accessMode: "app" | "list" | "open" | "restricted";
  senderAllowlist: readonly string[];
  groupAllowlist: readonly string[];
  thinkingPolicy: "cot-visible" | "cot-discard" | "stream-only";
  reasoningEffort: string;
  permissionPreset: string;
};

export function plainConfig(input: Config | ParsedConfig): ResolvedConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = isVolatile(value) ? (value as { get(): unknown }).get() : value;
  }
  return out as ResolvedConfig;
}

export const inject = ["agents", "llm", "attachments", "credentials", "sessionController", "permissionPresets", "workspaceRegistry"];

export const Config = z.object({
  enabled: z.boolean().default(false).volatile().comment("启用飞书连接（关闭即断连）"),
  appId: z.string().default("").volatile().comment("飞书 App ID（v1 手填；扫码建应用见二期）"),
  appSecretRef: z.string().role("credential-ref").default("CONNECT_LARK_APP_SECRET").volatile().comment("App Secret 的凭据缝引用名"),
  appSecretPreview: z.string().default("").volatile().comment("App Secret 前 5 位预览；完整 Secret 只存凭据缝"),
  defaultPath: z.string().default("").volatile().comment("默认工作区路径（留空=宿主 cwd）"),
  openId: z.string().default("").volatile().comment("你的 open_id（私聊/测试消息）"),
  domain: z.union(["feishu", "lark"]).default("feishu").volatile().comment("飞书或 Lark"),
  requireMention: z.boolean().default(true).volatile().comment("群聊需 @ 机器人才触发；默认 true，改为 false 将接受群内任意消息"),
  agentOwnership: z.union(["owned-per-chat", "attach-gui"]).default("owned-per-chat").volatile().comment("agent 所有权：默认每个聊天独立 agent；attach-gui 仅高级场景使用"),
  attachSessionId: z.string().default("").volatile().comment("attach-gui 时的目标 session id（无全局 current agent 可读）"),
  provider: z.string().default("").volatile().comment("owned-per-chat 时必填；默认空串是占位"),
  model: z.string().default("").volatile().comment("owned-per-chat 时必填"),
  accessMode: z.union(["app", "list", "open", "restricted"]).default("app").volatile().comment("访问模式：app=跟随飞书应用的可用范围（默认，插件不额外限制）；list=只允许授权名单与租户管理员"),
  senderAllowlist: z.array(z.string()).default([]).volatile().comment("私聊用户限制；restricted 模式下为空则拒绝所有私聊"),
  groupAllowlist: z.array(z.string()).default([]).volatile().comment("群聊限制；restricted 模式下为空则拒绝所有群聊"),
  thinkingPolicy: z.union(["cot-visible", "cot-discard", "stream-only"]).default("cot-visible").volatile().comment("思考展示：cot-visible=在卡片中显示思考过程；cot-discard/stream-only=不显示"),
  reasoningEffort: z.string().default("").volatile().comment("思考强度；留空跟随 DSH 当前模型默认配置"),
  permissionPreset: z.string().default("").volatile().comment("权限模式；留空跟随 DSH 默认，支持 read-only/workspace-write/danger-full-access/auto"),
});

type AnyCtx = any;

/**
 * Run a promise with a deadline.
 *
 * The result is a tagged outcome rather than the bare value: a resolved
 * Promise&lt;void&gt; carries undefined, so undefined cannot double as "timed out".
 */
type Timed<T> = { ok: true; value: T } | { ok: false };

/** Send a reply with a deadline so a hung request cannot stall the chat. */
async function sendBounded(chan: LarkChannel, chatId: string, markdown: string): Promise<void> {
  const sent = await withTimeout(chan.send(chatId, { markdown }), 15000);
  if (!sent.ok) throw new Error("send timed out");
}

/** 这个 DSH 实例对外公布的地址（隧道域名等），浏览器页面的 origin 就是它。 */
function advertisedOrigin(ctx: AnyCtx): string {
  try {
    const url = ctx?.get?.("webApp")?.getAdvertisedUrl?.();
    if (typeof url !== "string") return "";
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** 本机回环地址：直接用 http://127.0.0.1:8083 打开页面时也该能用。 */
function loopbackOrigins(): string[] {
  const origins: string[] = [];
  for (let port = 3000; port <= 9200; port++) {
    origins.push("http://127.0.0.1:" + String(port), "http://localhost:" + String(port));
  }
  return origins;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<Timed<T>> {
  return new Promise<Timed<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false }); } }, ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true, value }); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false }); } },
    );
  });
}

/** How long to wait for the card producer to start before treating it as failed.
 *  Read at call time (not module load) so tests can override it per-run. */
function streamReadyTimeoutMs(): number {
  return Number(process.env.CONNECT_LARK_STREAM_TIMEOUT_MS) || 10_000;
}

export async function resolveAppSecret(ctx: AnyCtx, parsed: Config | ParsedConfig): Promise<string> {
  const { appSecretRef } = plainConfig(parsed);
  if (typeof appSecretRef !== "string" || !isCredentialRefName(appSecretRef)) {
    throw new Error(
      "[connect-lark] appSecretRef " + String(appSecretRef) + " is not a valid credential " +
      "reference name (expected a POSIX shell identifier such as CONNECT_LARK_APP_SECRET)",
    );
  }
  const ref = credentialRef(appSecretRef);
  const hit = await ctx.credentials.resolve(ref);
  const value = hit?.value;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "[connect-lark] credential " + appSecretRef + " resolved to an unusable value" +
      " (" + (value === null ? "null" : typeof value) + ") — set it to a non-blank string before " +
      "enabling the Feishu connection",
    );
  }
  return value;
}

export function buildUserMessage(
  content: Parameters<typeof createUserMessage>[0]["content"],
  source?: Parameters<typeof createUserMessage>[0]["source"],
) {
  return createUserMessage({ content, source: source ?? { kind: "user" } });
}

// ---- Optional per-chat-kind access restrictions ----

export function passesWhitelist(
  plain: ResolvedConfig,
  chatId: string,
  senderId: string,
  chatType: "p2p" | "group" = "p2p",
  managerOpenId = "",
): boolean {
  // "app" defers entirely to the Feishu app's own 可用范围: whoever can
  // already DM the bot is the audience, so the plugin adds no second gate.
  if (plain.accessMode === "app") return true;
  // The legacy "open" meant "unrestricted DMs" while groups and openId still
  // applied. Keep that narrowing so an upgrade does not widen access.
  if (plain.accessMode === "open") {
    if (chatType === "group") {
      return plain.groupAllowlist.length === 0 || plain.groupAllowlist.includes(chatId);
    }
    if (plain.openId) return plain.openId === senderId;
    return true;
  }
  // "list" (and the legacy "restricted") narrows to the explicit grants.
  if (chatType === "group") return plain.groupAllowlist.includes(chatId);
  if (plain.senderAllowlist.includes(senderId)) return true;
  if (plain.openId && plain.openId === senderId) return true;
  // The tenant manager is always allowed: the app administrator must not be
  // locked out of the bot they administer.
  return Boolean(managerOpenId) && managerOpenId === senderId;
}

/** Resolve model and effort from explicit overrides or the DSH new-session default. */
export function resolveAgentModelOptions(
  plain: Pick<ResolvedConfig, "provider" | "model" | "reasoningEffort">,
  catalog: any,
): { provider: string; model: string; reasoningEffort?: string } {
  const hasOverride = Boolean(plain.provider && plain.model);
  const provider = hasOverride ? plain.provider : catalog.default.provider;
  const model = hasOverride ? plain.model : catalog.default.model;
  let reasoningEffort = plain.reasoningEffort;
  if (!reasoningEffort) {
    if (hasOverride) {
      const group = (catalog.groups ?? []).find((item: any) => item.id === provider);
      const selected = group?.models?.find((item: any) => item.id === model);
      reasoningEffort = selected?.reasoning?.defaultEffort ?? "";
    } else {
      reasoningEffort = catalog.default.reasoningEffort ?? "";
    }
  }
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/**
 * 让一个会话成为 DSH「一等公民」：
 *  1) 走宿主标准 sessionController.create（幂等：该 id 已存则复用）→ 进标准会话库 + 投影缓存；
 *  2) 用 workspaceRegistry.resolveByPath(cwd)（canonical realpath 匹配）把会话挂进工作区归属
 *     → Web 左栏当场可见（旧代码用 workspaces.find(精确路径) 建会话，冷会话不在归属表，故不可见）；
 *  3) 命名（有 title 时）。
 * 全程只调宿主公开 API，不写配置、不写 patch、不触发 HMR。
 */
async function ensureFirstClass(ctx: AnyCtx, sessionId: string, cwd: string, title?: string): Promise<void> {
  // 用 workspaceId（而非裸 cwd）建会话：宿主标准 create({workspaceId, sessionId}) 会
  //  ① honor 我们给的确定性 sessionId（不会替换成 blank）② 当场 attachSession 进工作区归属
  // （真机实证 2026-11-15：create({workspaceId, sessionId:custom}) → honored + attached + 进 membership）。
  // 幂等：该 id 已存且是工作区成员则复用；writer-held / already-exists 由 createOrResumeAgent 兜底。
  const ws = await ctx.workspaceRegistry?.resolveByPath?.(cwd);
  try {
    if (ws) await ctx.sessionController?.create?.({ workspaceId: ws.id, sessionId });
    else await ctx.sessionController?.create?.({ cwd, sessionId });
  } catch (error) {
    if (!/writer-held|already exists|already registered|active write handle|reusable/i.test((error as Error).message)) {
      ctx.logger?.warn?.("[connect-lark] first-class create: " + (error as Error).message);
    }
  }
  try {
    if (ws) await ws.attachSession?.(sessionId);
  } catch (error) {
    ctx.logger?.warn?.("[connect-lark] first-class attachSession: " + (error as Error).message);
  }
  if (title) {
    try { await ctx.sessionController?.rename?.({ sessionId, title }); } catch { /* 命名失败不阻断 */ }
  }
}

/**
 * P4：列出可 resume 的历史会话（sessionController.list）。
 * 双版本形状差异归一化：rc.2 的 list() 返回 SessionSummary[]；rc.3 返回
 * { items: SessionSummary[] }。此处统一为 HistorySessionOption[]（只取卡片需要的字段）。
 * 失败/无会话 → 空数组（卡片显示「暂无历史会话」）。
 */
/** 历史卡最多展示的会话条数（真机实测：实例里 ~300 会话时全量下拉会让飞书建卡超时）。 */
const HISTORY_LIMIT = 20;

/** 冷读一个会话的标题（session/title 事件的最后一个值）。
 *  优先用 sessionQuery.readSession（完整日志）；不可用时 inspectSession 读投影。
 *  读不到 → 空串（调用方用占位标题）。 */
async function readColdSessionTitle(query: any, sessionId: string): Promise<string> {
  if (!query) return "";
  if (typeof query.readSession === "function") {
    const loaded: any = await query.readSession(sessionId);
    const events: any[] = loaded?.events ?? [];
    const titles = events.filter((e) => e?.type === "session/title" && typeof e?.data?.title === "string");
    const last = titles[titles.length - 1];
    return last?.data?.title ?? "";
  }
  if (typeof query.inspectSession === "function") {
    return String(await query.inspectSession(sessionId, (session: any) => {
      try {
        const events = session?.snapshotEvents?.() ?? [];
        const titles = events.filter((e: any) => e?.type === "session/title" && typeof e?.data?.title === "string");
        return titles[titles.length - 1]?.data?.title ?? "";
      } catch { return ""; }
    }) ?? "");
  }
  return "";
}

async function listSessions(ctx: AnyCtx, limit: number = HISTORY_LIMIT): Promise<{ sessions: Array<{ sessionId: string; title: string; cwd?: string; updatedAt: number }>; total: number }> {
  try {
    const ctrl = ctx.sessionController;
    if (!ctrl?.list) return { sessions: [], total: 0 };
    // 双版本签名：rc.2 = list(signal?) → 返回 SessionSummary[]；
    //              rc.3 = list(request, signal) → 返回 { items: SessionSummary[] }。
    // 无参调用对两者都安全（rc.2 的 signal=undefined 跳过 throwIfAborted；
    // rc.3 忽略 request、signal=undefined 亦可）——**不能传 {}**：rc.2 会当 signal 用
    // 而抛 "signal.throwIfAborted is not a function"（真机实测踩过）。
    const raw: any = await ctrl.list();
    const rows: any[] = Array.isArray(raw) ? raw : (raw?.items ?? []);
    const mapped = rows
      .filter((r) => typeof (r?.sessionId ?? r?.id) === "string" && (r.sessionId ?? r.id))
      .map((r) => ({
        sessionId: r.sessionId ?? r.id,
        title: r.projections?.values?.sessionListMetadata?.title ?? r.title ?? r.sessionId ?? r.id,
        cwd: typeof r.cwd === "string" ? r.cwd : undefined,
        updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      }))
      // 最近优先：实例里可能有几百个会话，全量塞进下拉会让飞书建卡超时（真机实测）
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // 限量：卡片最多展示 limit 条（其余在卡片上注明总数）；校验场景传大 limit 取全集
    const total = mapped.length;
    const page = mapped.slice(0, limit);
    // 真实标题：rc.2 的 sessionListMetadata 只有 {blank, lastPromptAt}，**不含标题**
    // （真机实测：历史卡选项显示成裸 sessionId）。标题在会话日志的 session/title 事件里，
    // 通过 dsh-session-query 冷读（readSession 或 inspectSession）取出；只读本页，
    // 有限并发 + 每条有超时，任何失败回退到"未命名对话（id 前缀）"。
    const titles = new Map<string, string>();
    const query = ctx.get?.("sessionQuery");
    const probeTitle = async (sessionId: string): Promise<void> => {
      try {
        const result = await withTimeout(readColdSessionTitle(query, sessionId), 5_000);
        if (result.ok && result.value) titles.set(sessionId, result.value);
      } catch { /* 读不到就留空，外层用占位标题 */ }
    };
    await Promise.all(page.map((s) => probeTitle(s.sessionId)));
    for (const s of page) {
      s.title = titles.get(s.sessionId) ?? "未命名对话（" + s.sessionId.slice(0, 12) + "…）";
    }
    return { sessions: page, total };
  } catch (e) {
    ctx.logger?.warn?.("[connect-lark] list sessions failed: " + (e as Error).message);
    return { sessions: [], total: 0 };
  }
}

/** Create a per-chat agent, reusing live agents and resuming persisted sessions. */
export async function createOrResumeAgent(ctx: AnyCtx, sessionId: string, meta: { cwd?: string }, agentOptions: unknown, permissionPreset = ""): Promise<{ agent: any; sessionId: string; handle: any }> {
  const applyPreset = (agent: any) => {
    if (permissionPreset) ctx.permissionPresets.set(agent.session, permissionPreset);
    // 模型/强度：插件配置显式设了模型时，用配置覆盖会话里持久化的旧模型投影
    // （会话投影在 resume 时优先于 agentOptions，会让卡片切换的新模型不生效——
    //  真机实证 2026-11-14：配置已是 minimax，请求头仍是 agnes）。
    // 配置未设模型时不动会话投影（继续跟随用户在 DSH 页面的选择）。
    const opts = agentOptions as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
    if (opts?.provider && opts?.model) {
      try {
        agent.model?.select?.({
          provider: opts.provider,
          model: opts.model,
          ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        });
      } catch { /* 选择失败不阻断会话创建 */ }
    }
  };
  // Prefer the host's ordinary-session resolver: it can adopt an already live
  // Agent instead of creating a second writer for the same Session.
  if (ctx.sessionController?.resolveAgent) {
    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if (resolved?.agent) {
        applyPreset(resolved.agent);
        return { agent: resolved.agent, sessionId, handle: null };
      }
    } catch (error) {
      if (!/writer-held|active write handle/i.test((error as Error).message)) throw error;
    }
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const live = ctx.agents.get(sessionId);
    if (live) {
      applyPreset(live);
      return { agent: live, sessionId, handle: null };
    }
    try {
      const handle = await ctx.agents.create({ sessionId, meta, agentOptions });
      applyPreset(handle.agent);
      return { agent: handle.agent, sessionId, handle };
    } catch (error) {
      if (!/already exists|already registered|active write handle/i.test((error as Error).message)) throw error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions });
        applyPreset(handle.agent);
        return { agent: handle.agent, sessionId, handle };
      } catch (resumeError) {
        if (!/active write handle|writer-held/i.test((resumeError as Error).message)) throw resumeError;
        // A stale or externally held writer must not permanently disable the
        // bot. Start a fresh per-chat session instead of failing the turn.
        const fallbackSessionId = sessionId + ":" + Date.now();
        const handle = await ctx.agents.create({ sessionId: fallbackSessionId, meta, agentOptions });
        applyPreset(handle.agent);
        return { agent: handle.agent, sessionId: fallbackSessionId, handle };
      }
    }
  }
  throw new Error("unreachable");
}

/** 终稿思考面板保留的尾部字符数：CardKit 单卡有 ~30KB 上限，长思考截尾防更新失败。 */
const FINAL_THINKING_TAIL = 4000;
/** 卡片更新节流：每个 token 一次 PATCH 会被飞书限流，卡片反而像冻结。 */
const CARD_UPDATE_INTERVAL_MS = 900;

/** 把运行失败翻译成用户能行动的话：上游不可达 = DSH 服务没开。 */
function friendlyRunFailure(error: Error): string {
  const m = String(error.message || error);
  if (/ECONNREFUSED|fetch failed|connect|socket|hang/i.test(m)) {
    return "DSH 服务未开启——请先启动本机 DSH，再发送消息。";
  }
  return "**运行失败：** " + m;
}

/** Update one streaming rich card with the latest answer and optional CoT.
 * final=true 时思考过程收进折叠面板（截尾）；legacyThinking=true 渲染旧版引用块，
 * 作为折叠面板被飞书拒绝时的回退版式。 */
async function updateRunCard(
  slot: RunSlot,
  thinkingPolicy: ResolvedConfig["thinkingPolicy"],
  opts: { final?: boolean; legacyThinking?: boolean; footer?: { statusLine?: string; panelArgs?: SettingsCardOptions; onBuilt?: (card: object) => void } } = {},
): Promise<void> {
  if (!slot.streamController) return;
  const lines: string[] = [];
  const thinkingQuoted = () => slot.thinkingText.split("\n").map((line) => "> " + line).join("\n");
  const showThinking = thinkingPolicy === "cot-visible" && Boolean(slot.thinkingText);
  const bodyStarted = Boolean(slot.accumulatedText) || Boolean(opts.final);
  // 标题栏即状态：thinking→正在思考… tool→正在调用工具… text→正在生成… 终稿→DSH 回复（绿头）
  const phaseTitle = slot.phase === "tool" ? "正在调用工具…"
    : slot.phase === "text" ? "正在生成…"
    : "正在思考…";
  const title = slot.failedWith ? "DSH 回复" : opts.final ? "DSH 回复" : phaseTitle;
  // 流式思考只滚动最近 3 行（完整过程终稿折叠后可看）
  const thinkingTail = (maxLines: number) => {
    const all = slot.thinkingText.split("\n");
    return (all.length > maxLines ? "…（上文略）\n" : "") + all.slice(-maxLines).join("\n");
  };
  // 终稿面板标题带思考用时（runStartedAt→thinkingEndedAt）
  const thinkingSeconds = slot.thinkingEndedAt && slot.runStartedAt
    ? Math.max(1, Math.round((slot.thinkingEndedAt - slot.runStartedAt) / 1000))
    : null;
  let panels: Array<{ title: string; content: string }> | undefined;
  if (slot.failedWith) {
    lines.push("**" + friendlyRunFailure(slot.failedWith) + "**");
  } else if (showThinking && !bodyStarted && !opts.legacyThinking) {
    // 纯思考阶段：最近 3 行实时滚动（终稿折叠后可看完整过程）
    lines.push("**思考过程**", thinkingTail(3));
  } else if (showThinking && !opts.legacyThinking) {
    // 正文已开始：思考折叠为置顶面板（标题带思考用时），正文在其下
    const body = slot.thinkingText.length > FINAL_THINKING_TAIL
      ? "…（仅保留最近 " + FINAL_THINKING_TAIL + " 字，完整过程见会话）\n" + slot.thinkingText.slice(-FINAL_THINKING_TAIL)
      : slot.thinkingText;
    panels = [{ title: thinkingSeconds ? "思考过程 · " + thinkingSeconds + "s" : "思考过程", content: thinkingQuoted() }];
    lines.push(slot.accumulatedText || "本次回复没有文本输出。");
  } else if (showThinking) {
    // 折叠面板被飞书拒绝时的回退版式：思考同样在正文上方
    lines.push("**思考过程**", thinkingQuoted(), "---", slot.accumulatedText || "正在生成回复…");
  } else if (slot.accumulatedText) {
    lines.push(slot.accumulatedText);
  } else if (opts.final) {
    lines.push("本次回复没有文本输出。");
  }
  // Issue #17：状态行放在 header.subtitle（官方字段）——与正文彻底分离，一眼可见
  const timestamp = new Date().toISOString();
  const buttons = [{ text: "dsh-nano-market", url: "https://github.com/oh-summy/dsh-nano-market" }];
  const appendElements = opts.footer?.panelArgs ? [buildSettingsPanel(opts.footer.panelArgs)] : undefined;
  const card = richCard({
    title,
    headerSubtitle: opts.footer?.statusLine,
    color: opts.final ? "green" : "blue",
    lines,
    panels,
    appendElements,
    note: "connect-lark · by @oh-summy · " + timestamp,
    buttons,
  });
  await slot.streamController.update(card);
  if (appendElements) opts.footer?.onBuilt?.(card);
}

/** 终稿更新：先试折叠面板版式，被飞书拒绝时回退旧版引用块。 */
async function finalizeRunCard(
  slot: RunSlot,
  thinkingPolicy: ResolvedConfig["thinkingPolicy"],
  footer?: { statusLine?: string; panelArgs?: SettingsCardOptions; onBuilt?: (card: object) => void },
): Promise<void> {
  if (!slot.streamController) return;
  try {
    await updateRunCard(slot, thinkingPolicy, { final: true, footer });
  } catch (panelError) {
    try { await updateRunCard(slot, thinkingPolicy, { final: true, legacyThinking: true, footer }); }
    catch { throw panelError; }
  }
}

// ---- apply() ----

export function apply(ctx: AnyCtx, config: Config | ParsedConfig = {}) {
  let plain = plainConfig(config);
  // 说明：模型/强度/权限/工作区不再写插件配置（不再走 configEditor.edit → patch → HMR），
  // 而是写【会话投影】（agent.model.select / permissionPresets.set）+ per-chat 状态。
  // 因此不再有「配置编辑触发 entry 重载」这条路径，HMR 嵌套事务问题随之消失（无需逃逸）。
  let channel: LarkChannel | null = null;
  let runManager: RunManager | null = null;
  let unsubMessage: (() => void) | null = null;
  let unsubCardAction: (() => void) | null = null;
  let directoryService: DirectoryService | null = null;
  // 租户管理员（应用的可用范围里的 owner）自动放行，不必手填 open_id。
  let managerOpenId = "";
  let unsubEvents: Array<() => void> = [];
  let generation = 0;
  let transition: Promise<void> = Promise.resolve();

  // ---- Issue #17：卡片内切换（一等公民语义：卡片修改 = 写该 chat 会话的投影
  // （agent.model.select / permissionPresets.set）+ per-chat 状态（session-map.ts），
  // 不写插件配置、不写 patch、不触发 HMR；重启后会话投影由宿主重放，不丢）----
  // chatId → 聊天类型（cardAction 事件不带 chatType，白名单需要它；message 事件时记录）
  const chatTypeCache = new Map<string, "p2p" | "group">();
  // chatId → 最近一张终稿回复卡（含内嵌设置面板）。卡片回调选择后用它就地重建，
  // 不弹新卡；slot 被 TTL 驱逐后仍可用（下一轮回复会重新写入）。
  const lastReplyCards = new Map<string, object>();
  // sessionId → chatId（feishu_send_media 工具用：agent 侧发媒体时找到目标对话）
  const sessionChat = new Map<string, string>();
  // P5 审批：callId → 待决审批（飞书按钮点击后 resolve）。绑 chatId 用于发卡与终态更新。
  // 放在 apply() 作用域：审批监听器在 apply 顶层注册，需要跨 boot/cleanup 存活。
  const pendingApprovals = new Map<string, {
    resolve: (outcome: "allowed-once" | "rejected" | "cancelled") => void;
    chatId: string;
    messageId: string;
    toolName: string;
    expiresAt: number;
  }>();
  const APPROVAL_TTL_MS = 5 * 60_000;
  // 已注册过媒体工具的 sessionId（agent 域 ctx 重复注册会抛错，按会话幂等）
  const mediaRegistered = new Set<string>();
  // per-chat 状态（一等公民维度的单一事实源，持久化到 DSH home 下，重启恢复）：
  // 该 chat 当前会话 id + 显式选的模型/强度/权限/工作区。卡片「当前值」读它（同步），
  // 会话投影（agent.model.select / permissionPresets.set）是运行时事实源，二者保持一致。
  const statePath = process.env.CONNECT_LARK_SESSION_MAP || defaultStatePath();
  const chatStates: ChatStateMap = loadStates(statePath);
  const chatState = (chatId: string): ChatState => chatStates[chatId] ?? { updatedAt: 0 };
  const touchState = (chatId: string, patch: Partial<ChatState>): void => {
    const cur = chatStates[chatId] ?? { updatedAt: 0 };
    chatStates[chatId] = { ...cur, ...patch, updatedAt: Date.now() };
    try { saveStates(statePath, chatStates); } catch (e) { ctx.logger?.warn?.("[connect-lark] save per-chat state: " + (e as Error).message); }
  };
  /** 该 chat 当前的工作区 cwd：per-chat 显式选择 > 插件默认 > 宿主 cwd。 */
  const currentCwd = (chatId: string): string => chatState(chatId).cwd || plain.defaultPath || process.cwd();
  /** 给 owned-per-chat 的 agent 注册桥内发媒体工具：agent 生成图片/文件后
   *  直接经当前 bot 发给用户，而不是绕道 lark-cli 等其他应用（真机反馈 2026-11-13）。 */
  const registerMediaTool = (agent: any, chatId: string, sessionId: string): void => {
    sessionChat.set(sessionId, chatId);
    if (mediaRegistered.has(sessionId)) return;
    mediaRegistered.add(sessionId);
    try {
      agent.ctx?.tools?.register?.({
        name: "feishu_send_media",
        description: "把本机生成的图片或文件通过飞书发给当前对话的用户。图片（png/jpg/jpeg/webp/gif）以图片消息发送，其他扩展名以文件消息发送。path 必须是本机绝对路径。需要把运行产物（图片、海报、文档等）交付给用户时使用。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要发送的本机文件绝对路径" },
            caption: { type: "string", description: "可选说明文字，随文件以一条纯文本消息发送" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean", description: "是否发送成功" },
              kind: { type: "string", description: "image 或 file" },
              messageId: { type: "string", description: "飞书消息 id" },
              error: { type: "string", description: "失败原因" },
            },
            additionalProperties: false,
          },
        },
        async execute(args: { path: string; caption?: string }, exec: any) {
          const ch = channel;
          if (!ch) return { ok: false, error: "飞书连接不可用" };
          const sid = exec?.agent?.session?.id ?? sessionId;
          const target = sessionChat.get(sid);
          if (!target) return { ok: false, error: "找不到该会话对应的飞书对话（可能已过期或被清理）" };
          const info = await stat(args.path).catch(() => null);
          if (!info || !info.isFile()) return { ok: false, error: "文件不存在或不可读: " + args.path };
          const ext = path.extname(args.path).toLowerCase();
          const isImage = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
          const input = isImage
            ? { image: { source: args.path } }
            : { file: { source: args.path, fileName: path.basename(args.path) } };
          const sent = await withTimeout(ch.send(target, input as any), 30_000);
          if (!sent.ok) return { ok: false, error: "发送超时（30s）" };
          if (args.caption) void Promise.resolve(ch.send(target, { text: args.caption })).catch(() => {});
          return { ok: true, kind: isImage ? "image" : "file", messageId: (sent.value as any)?.messageId };
        },
      });
      ctx.logger?.info?.("[connect-lark] feishu_send_media tool registered for " + sessionId);
    } catch (e) {
      // 重复注册等场景：工具已存在则忽略
      ctx.logger?.warn?.("[connect-lark] media tool register skipped: " + (e as Error).message);
    }
  };
  /** 重建最近一张回复卡的内嵌设置面板（唯一实现：同步、零 await、零网络）。
   *  overrides 用于「用户刚选的模型」尚未写入配置时，面板先按新模型渲染
   *  （档位必须跟着所选模型走，否则会选到别的模型的档位 → DSH 拒绝该 effort）。
   *  卡片回调里直接用返回值就地更新；其他场景用 fire-and-forget。 */
  const rebuildReplyCard = (chatId: string, overrides?: { provider?: string; model?: string; reasoningEffort?: string }): object | undefined => {
    const stored = lastReplyCards.get(chatId);
    if (!stored) return undefined;
    const args = settingsCardArgs(chatId, overrides);
    const effortList = effortOptionsFor(args);
    const clone = JSON.parse(JSON.stringify(stored)) as { header?: Record<string, unknown>; body?: { elements?: Array<Record<string, unknown>> } };
    const els = clone.body?.elements ?? [];
    const idx = els.findIndex((e) => e.tag === "collapsible_panel"
      && typeof (e.header as any)?.title?.content === "string"
      && String((e.header as any).title.content).startsWith("⚙️"));
    if (idx < 0) return undefined;
    els[idx] = buildSettingsPanel({ ...args, effortList });
    if (clone.header && typeof clone.header === "object") {
      const shown = buildDisplay(chatId) ?? {};
      if (overrides?.model) shown.model = overrides.model;
      clone.header.subtitle = { tag: "plain_text", content: settingsStatusLine(shown, plain.agentOwnership === "attach-gui") };
    }
    lastReplyCards.set(chatId, clone);
    return clone;
  };
  // 卡片回调幂等去重（60s TTL）。选择卡/回复卡发送失败不记入（失败路径会清除键）。
  const dedupTable = new Map<string, number>();
  const dedupClaim = (key: string): boolean => {
    const now = Date.now();
    if (dedupTable.has(key) && (dedupTable.get(key) ?? 0) > now) return false;
    // 防长期运行内存增长：超限时顺带清理过期键
    if (dedupTable.size > 500) {
      for (const [k, ts] of dedupTable) if (ts <= now) dedupTable.delete(k);
    }
    dedupTable.set(key, now + 60_000);
    return true;
  };
  // 高权限档二次确认：per-chat，绑发起人 openId，30s TTL（方案 §4.3 / P1-3）
  const pendingConfirms = new Map<string, { openId: string; permission: string; expiresAt: number }>();
  // 最近一次回复所在的 chat（卡片回调的 pending key 与就地重建目标）
  let lastRepliedChatId = "";
  const CONFIRM_TTL_MS = 30_000;
  // 设置卡片数据缓存（open-settings 时刷新一次；select 回调用缓存同步构建就地更新）
  let settingsData: {
    catalog: SettingsCardOptions["catalog"];
    workspaces: Array<{ id: string; title: string; path: string }>;
    permissions: Array<{ value: string; name: string }>;
    defaultPermission: string;
  } | null = null;

  /** 历史卡的 markdown 兜底：卡片发不出去时，至少把会话清单以文本给出。 */
  const sendHistoryFallback = async (
    chan: LarkChannel,
    chatId: string,
    sessions: Array<{ sessionId: string; title: string }>,
    total: number,
    reason: string,
  ): Promise<void> => {
    try {
      const lines = sessions.slice(0, 10).map((s, i) => `${i + 1}. ${s.title}`);
      const body = [
        "🗂 **历史对话**（卡片发送${reason}，改用文本列出）",
        ...(lines.length ? lines : ["（暂无可列出的历史会话）"]),
        "",
        "切换方式：展开回复卡的「⚙️ 快捷设置」，点「🗂 历史对话」按钮选择（卡片恢复后可用）。",
      ].join("\n");
      await sendBounded(chan, chatId, body);
    } catch (e) {
      ctx.logger?.warn?.("[connect-lark] history fallback failed: " + (e as Error).message);
    }
  };

  const refreshSettingsData = async (): Promise<void> => {
    try {
      const catalog = await ctx.sessionController.modelCatalog();
      const workspaces = (ctx.workspaceRegistry?.list?.() ?? []).map((w: any) => ({ id: w.id, title: w.title, path: w.path }));
      const permCat = ctx.permissionPresets?.catalog?.() ?? { options: [], defaultPreset: "" };
      settingsData = { catalog, workspaces, permissions: permCat.options ?? [], defaultPermission: permCat.defaultPreset ?? "" };
    } catch (e) {
      ctx.logger?.warn?.("[connect-lark] settings data refresh failed: " + (e as Error).message);
    }
  };

  const settingsCardArgs = (chatId: string, overrides?: { provider?: string; model?: string; reasoningEffort?: string }): SettingsCardOptions => {
    // 一等公民：当前值来自 per-chat 状态（会话投影 + 映射），不再是插件配置（避免多处生效同一件事）。
    // overrides 用于「用户刚选的模型」尚未落投影时，面板先按新模型渲染（档位跟随所选模型）。
    const st = chatState(chatId);
    const wsPath = st.cwd || plain.defaultPath;
    const ws = wsPath ? settingsData?.workspaces.find((w) => w.path === wsPath) : undefined;
    const defaultTitle = wsPath ? "工作区（" + wsPath.split("/").filter(Boolean).pop() + "）" : "默认工作区";
    const provider = overrides?.provider ?? st.provider ?? "";
    const model = overrides?.model ?? st.model ?? "";
    const effort = overrides?.reasoningEffort !== undefined ? overrides.reasoningEffort : (st.reasoningEffort ?? "");
    const hasModel = Boolean(provider && model);
    return {
      catalog: settingsData?.catalog ?? { groups: [] },
      workspaces: settingsData?.workspaces ?? [],
      permissions: settingsData?.permissions ?? [],
      defaultPermission: settingsData?.defaultPermission ?? "",
      current: {
        workspaceId: ws ? ws.id : DEFAULT_OPTION_VALUE,
        provider: hasModel ? provider : undefined,
        model: hasModel ? model : undefined,
        reasoningEffort: effort || undefined,
        permission: st.permissionPreset || undefined,
      },
      hasPendingPermission: pendingConfirms.has(chatId), // 只提示本 chat 的待确认（P2-5）
      defaultWorkspaceTitle: defaultTitle,
    };
  };

  /** 需要二次确认的高危档位（宿主语义，dsh-permission-presets）：
   *  - danger-full-access：sandbox 全权 + approval **never**（永不询问，无提示直接放行）← 最危险
   *  - auto：sandbox 全权 + approval **ask**（每次调用都审查）← 比上者安全，不需确认
   *  只有「永不询问的全权访问」才需要用户点头。 */
  const isHighPermission = (option: string): boolean =>
    option === "danger-full-access";

  /** 候选配置的可读展示名（toast A→B 的 next 值）——不依赖配置已提交。 */
  const nextLabelOf = (field: string, partial: Partial<ResolvedConfig>): string => {
    if (field === "workspace") {
      if (!partial.defaultPath) return "默认工作区";
      const ws = settingsData?.workspaces.find((w) => w.path === partial.defaultPath);
      return ws?.title ?? partial.defaultPath;
    }
    if (field === "model") {
      const group = (settingsData?.catalog?.groups ?? []).find((g) => g.id === partial.provider);
      const m = group?.models?.find((mm) => mm.id === partial.model);
      return (group?.name ? group.name + " · " : "") + (m?.name ?? partial.model ?? "跟随 DSH 默认");
    }
    if (field === "effort") {
      if (!partial.reasoningEffort) return "跟随模型默认";
      const group = (settingsData?.catalog?.groups ?? []).find((g) => g.id === partial.provider);
      const m = group?.models?.find((mm) => mm.id === partial.model);
      const eff = m?.reasoning?.efforts?.find((x) => x.id === partial.reasoningEffort);
      return eff?.name ?? partial.reasoningEffort;
    }
    if (field === "permission") {
      if (!partial.permissionPreset) return "跟随 DSH 默认";
      const opt = settingsData?.permissions.find((x) => x.value === partial.permissionPreset);
      return opt?.name ?? partial.permissionPreset;
    }
    return "已设置";
  };

  /** 同步处理一次 select 回调：校验 → 生成该维度的候选值（高权限档先进 pending，
   *  确认后才进入候选）。候选经 applyDimState 落 per-chat 状态（重启恢复）+
   *  applyDimension 写会话投影（一等公民），不写插件配置、不写 patch。 */
  const applySelect = (
    chatId: string,
    name: string,
    option: string,
    openId: string,
  ): { error?: string; switchedWorkspace?: boolean; workspaceTitle?: string; partial?: Partial<ResolvedConfig>; pendingHigh?: boolean } => {
    if (name === "workspace") {
      if (option === DEFAULT_OPTION_VALUE) return { partial: { defaultPath: "" } };
      // 校验用实时 registry（settingsData 只是展示缓存）
      const ws = (ctx.workspaceRegistry?.list?.() ?? []).find((w: any) => w.id === option);
      if (!ws) return { error: "未知工作区" };
      const switched = (plain.defaultPath || "") !== ws.path;
      return { partial: { defaultPath: ws.path }, switchedWorkspace: switched, workspaceTitle: ws.title };
    }
    if (name === "model") {
      if (option === DEFAULT_OPTION_VALUE) return { partial: { provider: "", model: "", reasoningEffort: "" } };
      const sep = option.indexOf(":");
      if (sep <= 0) return { error: "无效的模型选项" };
      // 换模型时重置思考强度（跟随新模型默认），避免残留旧模型的 effort 被 DSH 拒绝
      return { partial: { provider: option.slice(0, sep), model: option.slice(sep + 1), reasoningEffort: "" } };
    }
    if (name === "effort") {
      if (option === DEFAULT_OPTION_VALUE) return { partial: { reasoningEffort: "" } };
      // 值由选择卡按当前模型枚举（精确路由解析），此处不再二次校验
      return { partial: { reasoningEffort: option } };
    }
    if (name === "permission") {
      // 先解析最终落盘值，再判高危——「设为 DSH 默认预设」解析出的默认预设本身可能是
      // danger-full-access，不能绕过二次确认（独立审查 P0-2）。
      const value = option === DEFAULT_OPTION_VALUE ? (settingsData?.defaultPermission ?? "") : option;
      if (isHighPermission(value)) {
        // 先清理过期的未决确认（防残留）
        const now = Date.now();
        for (const [cid, p] of pendingConfirms) if (p.expiresAt <= now) pendingConfirms.delete(cid);
        pendingConfirms.set(chatId, { openId, permission: value, expiresAt: now + CONFIRM_TTL_MS });
        return { pendingHigh: true };
      }
      pendingConfirms.delete(chatId);
      return { partial: { permissionPreset: value } };
    }
    return { error: "未知控件" };
  };

  /** 同步：把本次选择落到 per-chat 状态（卡片「当前值」立即反映 + 持久化供重启恢复）。 */
  const applyDimState = (chatId: string, partial: Partial<ResolvedConfig>): void => {
    const patch: Partial<ChatState> = {};
    if (partial.defaultPath !== undefined) patch.cwd = partial.defaultPath || undefined;
    if (partial.provider !== undefined) patch.provider = partial.provider || undefined;
    if (partial.model !== undefined) patch.model = partial.model || undefined;
    if (partial.reasoningEffort !== undefined) patch.reasoningEffort = partial.reasoningEffort || undefined;
    if (partial.permissionPreset !== undefined) patch.permissionPreset = partial.permissionPreset || undefined;
    touchState(chatId, patch);
  };

  /** 后台：把本次选择写进该 chat 会话的【投影】（一等公民；不写配置/patch/HMR）。
   *  模型/强度 → agent.model.select（会话 model/selection，重启重放）；权限 → permissionPresets.set。
   *  失败发一条飞书通知（不能只报成功 toast）。 */
  const applyDimension = async (chan: LarkChannel, chatId: string, controlName: string, partial: Partial<ResolvedConfig>): Promise<void> => {
    try {
      applyDimState(chatId, partial);
      if (controlName === "workspace") return; // cwd 是会话出身属性，靠会话 id 变化体现
      const cwd = currentCwd(chatId);
      const id = chatState(chatId).sessionId || ("connect-lark:" + chatId + cwdTag(cwd));
      await ensureFirstClass(ctx, id, cwd);
      const { agent } = await createOrResumeAgent(ctx, id, { cwd }, {}, "");
      if (controlName === "model" || controlName === "effort") {
        const st = chatState(chatId);
        const sel = st.provider && st.model
          ? { provider: st.provider, model: st.model, ...(st.reasoningEffort ? { reasoningEffort: st.reasoningEffort } : {}) }
          : resolveAgentModelOptions(plain, await ctx.sessionController.modelCatalog());
        agent.model?.select?.(sel);
      }
      if (controlName === "permission") {
        const p = chatState(chatId).permissionPreset || (settingsData?.defaultPermission ?? "");
        if (p) ctx.permissionPresets?.set?.(agent.session, p);
      }
    } catch (e) {
      ctx.logger?.warn?.("[connect-lark] apply dimension failed: " + (e as Error).message);
      void Promise.resolve(chan.send(chatId, { markdown: "⚠️ 设置未生效：" + (e as Error).message + "（请重试）" })).catch(() => {});
    }
  };


  /** 终稿卡片底部状态行的展示值（读该 chat 的 per-chat 状态——一等公民单一事实源）。 */
  const buildDisplay = (chatId?: string): SettingsDisplay | undefined => {
    // 一等公民：展示值来自 per-chat 状态（该 chat 会话的实际投影），非插件全局配置。
    const st = chatId ? chatState(chatId) : ({} as ChatState);
    const d: SettingsDisplay = {};
    const wsPath = st.cwd || plain.defaultPath;
    if (wsPath) {
      const ws = settingsData?.workspaces.find((w) => w.path === wsPath);
      d.workspace = ws?.title ?? wsPath;
    }
    if (st.model) {
      const group = (settingsData?.catalog?.groups ?? []).find((g) => g.id === st.provider);
      const m = group?.models?.find((mm) => mm.id === st.model);
      d.model = (group?.name ? group.name + " · " : "") + (m?.name ?? st.model);
    }
    if (st.reasoningEffort) {
      const group = (settingsData?.catalog?.groups ?? []).find((g) => g.id === st.provider);
      const m = group?.models?.find((mm) => mm.id === st.model);
      const e = m?.reasoning?.efforts?.find((x) => x.id === st.reasoningEffort);
      d.effort = e?.name ?? st.reasoningEffort;
    }
    if (st.permissionPreset) {
      const p = settingsData?.permissions.find((x) => x.value === st.permissionPreset);
      d.permission = p?.name ?? st.permissionPreset;
    }
    return d;
  };

  /** 思考强度选项——同步计算，零网络（catalog 的档位由宿主用 resolveModelInfo 精确路由解析
   *  填充，与 Web 选择器同源；实测 MiniMax = Low/Medium/High/Xhigh/Max、Agnes = Off/High）。
   *  绝不在卡片回调里 await 网络请求：飞书回调窗口约 3s，超时会报「回调服务超时」。 */
  const effortOptionsFor = (args: SettingsCardOptions): Array<{ label: string; value: string }> =>
    effortOptions(currentModelValue(args.current, args.catalog), args.catalog);

  const sendWorkspaceSwitchedNotice = async (chan: LarkChannel, chatId: string, title: string): Promise<void> => {
    try {
      await sendBounded(chan, chatId, "✅ 已切换到工作区 **" + title + "**。**下一条消息起**在 " + title +
        " 的上下文中对话（不继承刚才的对话）；切回原工作区可继续原对话。");
    } catch (e) {
      ctx.logger?.warn?.("[connect-lark] workspace notice failed: " + (e as Error).message);
    }
  };

  ctx.effect(() => {
    let dead = false;
    const isAlive = () => !dead;

    const boot = async () => {
      const current = ++generation;
      const currentAlive = () => isAlive() && generation === current;
      // Volatile wrappers are mutated in place; re-read on every (re)start.
      plain = plainConfig(config);
      // The Cordis bundle switch owns the connection lifecycle. The legacy
      // config.enabled field is intentionally not a second enable switch.
      // 1) Resolve secret (fails closed if unset).
      const appSecret = await resolveAppSecret(ctx, config);
      if (!currentAlive()) return;

      // 2) Create + connect channel.
      const chan = createLarkChannel({
        appId: plain.appId,
        appSecret,
        transport: "websocket",
        httpTimeoutMs: 30000,
        domain: plain.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
        // Group messages always require an @mention; this is not user-configurable.
        policy: { requireMention: plain.requireMention },
        // feishu_send_media 工具以本地文件路径发图/发文件——SDK 默认拒绝本地媒体源，
        // 这里显式放行宿主 home、宿主 cwd 与插件默认工作区（个人单机部署的务实白名单）。
        outbound: {
          allowedFileDirs: [os.homedir(), process.cwd(), ...(plain.defaultPath ? [plain.defaultPath] : [])],
        },
        safety: { chatQueue: { enabled: true } },
      });
      channel = chan;
      try {
        await chan.connect();
      } catch (e) {
        ctx.logger?.error?.("[connect-lark] channel connect failed: " + (e as Error).message);
        try { await chan.disconnect(); } catch { /* already gone */ }
        throw e;
      }
      if (!currentAlive()) { try { await chan.disconnect(); } catch { /* gone */ } return; }
      ctx.logger?.info?.("[connect-lark] channel connected");

      // 2.5) 探测租户管理员：可用范围里的 owner 默认可用，不必手填 open_id。
      // 每次连接探测一次（volatile 重连会重跑 boot，天然不带上一代残留）；
      // 飞书不可达时按「没有管理员」继续——不卡启动，也不给每条消息加一次通讯录 RTT。
      managerOpenId = "";
      try {
        const probe = await withTimeout(
          fetchDirectoryUsers((chan as any).rawClient),
          5000,
        );
        const directory = probe.ok ? probe.value : undefined;
        if (directory && directory.ok && directory.manager) {
          managerOpenId = directory.manager.openId;
          ctx.logger?.info?.("[connect-lark] tenant manager detected");
        }
      } catch (e) {
        ctx.logger?.warn?.("[connect-lark] manager lookup failed: " + (e as Error).message);
      }
      if (!currentAlive()) return;

      // 3) 授权用户目录（本机只读 HTTP 面）：配置页用同一个搜索框找人、找群。
      //    允许的来源 = 这个 DSH 实例自己的广告地址（隧道域名等）+ 回环地址。
      //    之前写死一份清单，Cloudflare 域名一换就 403，选择器直接废了。
      try {
        const allowed = new Set<string>(["null"]);
        for (const candidate of [advertisedOrigin(ctx), ...loopbackOrigins()]) {
          if (candidate) allowed.add(candidate);
        }
        directoryService = await startDirectoryService({
          allowedOrigins: allowed,
          directory: () => fetchDirectory((chan as any).rawClient),
        });
        ctx.logger?.info?.("[connect-lark] user directory on 127.0.0.1:" + directoryService.port);
      } catch (e) {
        ctx.logger?.warn?.("[connect-lark] user directory unavailable: " + (e as Error).message);
      }
      if (!currentAlive()) { try { await directoryService?.close(); } catch { /* gone */ } return; }

      // 4) Create run manager.
      // 卡片更新节流：先到期的 PATCH 立即发；窗口内的后续变更记脏标记，
      // 上一次 PATCH 落地后再补一发——流式期间最多 ~1 次/秒，终稿绕过节流直出。
      const scheduleCardUpdate = (slot: RunSlot) => {
        if (!slot.streamController) return;
        if (slot.cardUpdateTimer) { slot.cardDirty = true; return; }
        const fire = () => {
          slot.cardUpdateTimer = null;
          slot.lastCardUpdateAt = Date.now();
          void updateRunCard(slot, plain.thinkingPolicy)
            .catch((e) => ctx.logger?.warn?.("[connect-lark] card update failed: " + (e as Error).message))
            .finally(() => {
              if (slot.cardDirty && slot.streamController) {
                slot.cardDirty = false;
                scheduleCardUpdate(slot);
              }
            });
        };
        const elapsed = Date.now() - (slot.lastCardUpdateAt ?? 0);
        if (elapsed >= CARD_UPDATE_INTERVAL_MS) fire();
        else {
          const timer = setTimeout(fire, CARD_UPDATE_INTERVAL_MS - elapsed);
          timer.unref?.();
          slot.cardUpdateTimer = timer;
        }
      };
      runManager = new RunManager({
        resolveAgent: async (chatId, title) => {
          const existing = runManager?.getSlot(chatId);
          if (plain.agentOwnership === "attach-gui") {
            // attach-gui：共享 GUI 会话，设置入口整体禁用（P0-1 已裁决）。
            if (!plain.attachSessionId) {
              throw new Error("[connect-lark] attach-gui requires attachSessionId");
            }
            const agent = ctx.agents.get(plain.attachSessionId);
            if (!agent) throw new Error("[connect-lark] attachSessionId not found in agent registry");
            // 不 override 权限：attach-gui 共享宿主 GUI 会话，改了会动用户自己的 agent。
            return { agent, sessionId: plain.attachSessionId, handle: null };
          }
          // owned-per-chat：会话 id = 该 chat 的显式会话（「新对话/选历史」= host-uuid，存于 per-chat 状态）
          // > 确定性默认 connect-lark:<chatId>@<cwdTag(cwd)>。cwd 来自 per-chat 状态（一等公民）。
          const cwd = currentCwd(chatId);
          const expectedSessionId = chatState(chatId).sessionId || ("connect-lark:" + chatId + cwdTag(cwd));
          // 一等公民：宿主标准 create + 工作区归属（幂等；不再依赖启动时一次性 bootstrap）。
          await ensureFirstClass(ctx, expectedSessionId, cwd, title);
          const present = async (sessionId: string) => {
            if (existing?.titleSet) return;
            try {
              if (title) await ctx.sessionController.rename({ sessionId, title });
              if (existing) existing.titleSet = true;
            } catch (error) {
              ctx.logger?.warn?.("[connect-lark] session presentation failed: " + (error as Error).message);
            }
          };
          // 快路径：同一会话 id 且 agent 还活着 → 直接复用。
          // 模型/强度/权限是【会话投影】（applyDimension 已写），不再因配置指纹变化而重建会话。
          if (existing?.agent && existing.sessionId === expectedSessionId) {
            registerMediaTool(existing.agent, chatId, existing.sessionId);
            await present(existing.sessionId);
            return { agent: existing.agent, sessionId: existing.sessionId, handle: existing.handle };
          }
          // 会话 id 变化（切工作区/新对话）或 agent 已不在：释放旧 handle，新建/恢复（不 force-push 配置）。
          if (existing?.handle) {
            try { await Promise.resolve(existing.handle.dispose()); } catch { /* already gone */ }
            existing.handle = null;
            existing.agent = null;
            existing.sessionId = "";
          }
          const { agent, sessionId: resolvedSessionId, handle } = await createOrResumeAgent(ctx, expectedSessionId, { cwd }, {}, "");
          await present(resolvedSessionId);
          registerMediaTool(agent, chatId, resolvedSessionId);
          return { agent, sessionId: resolvedSessionId, handle };
        },
        buildMessage: (content: any, source: any) => buildUserMessage(content, source),
        subscribe: (agent, targetSessionId, onDelta, onTurnEnd, onError) => {
          // Track subscriptions for cleanup. The returned unsub removes them
          // from this array so it doesn't grow unbounded across runs.
          const track = (fn: () => void) => {
            unsubEvents.push(fn);
            return () => {
              try { fn(); } finally {
                unsubEvents = unsubEvents.filter((item) => item !== fn);
              }
            };
          };
          const unsubStream = track(ctx.on("agent/assistant-stream", (evt: any) => {
            if (evt.agent !== agent) return;
            // AssistantStreamFrame: chunk variant has chunk: StreamChunk.
            const frame = evt.frame;
            if (frame?.type === "chunk" && frame.chunk?.type === "text-delta") {
              onDelta(frame.chunk.text, "text");
            } else if (frame?.type === "chunk" && frame.chunk?.type === "reasoning-delta") {
              onDelta(frame.chunk.text, "reasoning");
            } else if (frame?.type === "chunk" && frame.chunk?.type === "tool-call-delta") {
              onDelta("", "tool");
            } else if (frame?.type === "chunk" && frame.chunk?.type === "tool-call-delta") {
              onDelta("", "tool");
            }
          }));
          const unsubTurn = ctx.on("session/event", (session: any, event: any) => {
            // Filter by session to avoid cross-session turn/end firing.
            if (event?.type === "turn/end" && session?.id === targetSessionId) onTurnEnd();
          });
          const unsubError = ctx.on("agent/error", (evt: any) => {
            if (evt.agent === agent) onError(evt.error);
          });
          // The track() helper already registered all three unsubs.
          // Return real cleanup so RunManager can call it on complete/fail.
          return () => {
            try { unsubStream(); } catch { /* gone */ }
            try { unsubTurn(); } catch { /* gone */ }
            try { unsubError(); } catch { /* gone */ }
          };
        },
        followup: (agent, message) => {
          (agent as { followup: (m: unknown) => void }).followup(message);
        },
        onCancel: (slot) => {
          // Never cancel the shared GUI session when running attach-gui.
          if (plain.agentOwnership !== "owned-per-chat") return;
          return ctx.sessionController.cancel({ sessionId: slot.sessionId });
        },
        onStart: (slot) => {
          const done = new Promise<void>((resolve) => { slot.streamDone = resolve; });
          // 心跳：每 3s 刷新一次状态行（用时计数），工具静默执行期间用户也能看到「还活着」
          slot.cardHeartbeat = setInterval(() => {
            if (slot.streamController) scheduleCardUpdate(slot);
          }, 3000);
          slot.cardHeartbeat.unref?.();
          slot.streamReady = new Promise<void>((resolve) => { slot.streamReadyResolve = resolve; });
          const thisTurn = slot.turnId;
          slot.streamPromise = chan.stream(slot.chatId, {
            card: {
              initial: richCard({
                title: "DSH 回复",
                color: "blue",
                lines: ["正在思考…"],
                note: "connect-lark · by @oh-summy · " + new Date().toISOString(),
                buttons: [{ text: "dsh-nano-market", url: "https://github.com/oh-summy/dsh-nano-market" }],
              }),
              producer: async (controller) => {
                // Bail out immediately if this stream belongs to a stale turn:
                // the turn timed out or was replaced, so the late producer must
                // not hold the channel open or update a card for an old run.
                if (slot.turnId !== thisTurn) return;
                slot.streamController = controller;
                slot.streamReadyResolve?.();
                await done;
              },
            },
          });
          Promise.resolve(slot.streamPromise).catch((e) => {
            // Only touch the current slot if this stream belongs to the same turn;
            // a stale stream must not pollute a newer run.
            if (slot.turnId === thisTurn) {
              slot.streamFailed = e as Error;
              slot.streamReadyResolve?.();
            }
            ctx.logger?.warn?.("[connect-lark] stream failed: " + (e as Error).message);
          });
        },
        onDelta: (slot) => {
          scheduleCardUpdate(slot);
        },
        onThinking: (slot) => {
          scheduleCardUpdate(slot);
        },
        onPhase: (slot) => {
          scheduleCardUpdate(slot);
        },
        onComplete: async (slot) => {
          try {
            // 终稿直出，绕过节流；挂起的节流定时器先撤掉
            if (slot.cardUpdateTimer) { clearTimeout(slot.cardUpdateTimer); slot.cardUpdateTimer = null; }
            slot.cardDirty = false;
            if (!slot.streamController && !slot.streamFailed) {
              // Bound the wait so a channel that never starts the producer cannot
              // leave this chat stuck in "finishing" forever.
              const ready = await withTimeout(slot.streamReady ?? Promise.resolve(), streamReadyTimeoutMs());
              if (!ready.ok) {
                slot.streamFailed = new Error("stream producer did not start within " + streamReadyTimeoutMs() + "ms");
              }
            }
            if (slot.streamFailed || !slot.streamController) {
              const reply = slot.accumulatedText || (slot.failedWith ? friendlyRunFailure(slot.failedWith) : "[connect-lark] 回复未生成");
              // Bound the send: a hung Feishu request would otherwise keep the
              // slot in "finishing" and stall every later message in this chat.
              await sendBounded(chan, slot.chatId, reply);
              return;
            }
            // 刷新设置卡数据（面板下拉的选项与当前值来自它）；失败时面板降级为占位项
            await refreshSettingsData();
            lastRepliedChatId = slot.chatId;
            const panelArgs = plain.agentOwnership === "owned-per-chat" ? settingsCardArgs(slot.chatId) : undefined;
            const effortList = panelArgs ? effortOptionsFor(panelArgs) : undefined;
            const footer = {
              statusLine: settingsStatusLine(buildDisplay(slot.chatId), plain.agentOwnership === "attach-gui"),
              panelArgs: panelArgs ? { ...panelArgs, effortList } : undefined,
              onBuilt: plain.agentOwnership === "owned-per-chat"
                ? (card: object) => {
                  // 上限：长期运行时不无限累积（个人使用 chat 数有限，仍加护栏）
                  if (lastReplyCards.size > 200) {
                    const oldest = lastReplyCards.keys().next().value;
                    if (oldest !== undefined) lastReplyCards.delete(oldest);
                  }
                  lastReplyCards.set(slot.chatId, card);
                }
                : undefined,
            };
            try {
              await finalizeRunCard(slot, plain.thinkingPolicy, footer);
            } catch (e) {
              const reply = slot.accumulatedText || (slot.failedWith ? friendlyRunFailure(slot.failedWith) : "[connect-lark] 回复未生成");
              await sendBounded(chan, slot.chatId, reply);
            }
          } finally {
            if (slot.cardHeartbeat) { clearInterval(slot.cardHeartbeat); slot.cardHeartbeat = null; }
            slot.streamDone?.();
          }
        },
      });

      // 5) Subscribe to messages.
      unsubMessage = chan.on("message", async (msg: any) => {
        if (!currentAlive()) return;
        if (!passesWhitelist(plain, msg.chatId, msg.senderId, msg.chatType, managerOpenId)) return;

        // 防无界增长：超上限整体清空（chatType 仅 cardAction 鉴权用，miss 时按更严格的
        // group 规则判，下一条 message 会重新记录——list/restricted 模式最多误拒一次点击）
        if (chatTypeCache.size > 2000) chatTypeCache.clear();
        chatTypeCache.set(msg.chatId, msg.chatType);
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text) return;
        // Issue #17：高权限档二次确认 —— 仅发起人回复「确认」生效，且不消费进 agent 回合（P1-3）
        if (plain.agentOwnership === "owned-per-chat" && (text.trim() === "确认" || text.trim().toLowerCase() === "confirm")) {
          const pending = pendingConfirms.get(msg.chatId);
          if (pending && pending.openId === msg.senderId && pending.expiresAt > Date.now()) {
            pendingConfirms.delete(msg.chatId);
            // 确认 → 写会话投影（一等公民；与卡片下拉同一语义，不写配置/patch/HMR）
            await applyDimension(chan, msg.chatId, "permission", { permissionPreset: pending.permission });
            const permName = (settingsData?.permissions ?? []).find((p) => p.value === pending.permission)?.name ?? pending.permission;
            void Promise.resolve(chan.send(msg.chatId, { markdown: "✅ 已应用权限：" + (permName || "跟随 DSH 默认") })).catch(
              (e) => ctx.logger?.warn?.("[connect-lark] confirm reply failed: " + (e as Error).message));
          } else {
            Promise.resolve(chan.send(msg.chatId, { markdown: "没有待确认的设置，或你不是发起人。" })).catch(() => {});
          }
          return;
        }

        // Handle images.
        // content must be ContentBlock[] (not raw string) per UserMessage contract.
        let content: unknown = [{ type: "text", text }];
        const images = extractImages(msg);
        if (images.length > 0) {
          // Gate against the model this chat will actually use. attach-gui lets
          // the host pick the model, so skip the gate there.
          // 按该 chat 实际使用的模型 gate（per-chat 状态；未选则跟随 DSH 默认路由）
          const gateSt = chatState(msg.chatId);
          let gateProvider = gateSt.provider ?? "";
          let gateModel = gateSt.model ?? "";
          let modelCatalogFailed = false;
          if (plain.agentOwnership === "owned-per-chat" && (!gateProvider || !gateModel)) {
            try {
              const cat = await ctx.sessionController.modelCatalog();
              const route = resolveAgentModelOptions(plain, cat);
              gateProvider = route.provider;
              gateModel = route.model;
            } catch (e) {
              modelCatalogFailed = true;
              ctx.logger?.warn?.("[connect-lark] cannot resolve default model for image gate: " + (e as Error).message);
            }
          }
          const admitResults = [];
          if (modelCatalogFailed) {
            // Fail-closed: cannot confirm the model supports images, so refuse
            // rather than saving an image the host model may not handle.
            admitResults.push({ supported: false, refs: [], reason: "cannot resolve the default model to verify image input" });
          }
          const limited = images.slice(0, MAX_IMAGES_PER_MESSAGE);
          if (images.length > MAX_IMAGES_PER_MESSAGE) {
            admitResults.push({ supported: false, refs: [], reason: "too many images in one message" });
          }
          for (const img of limited) {
            try {
              // channel.downloadResource downloads by fileKey (SDK-owned).
              const buf = await downloadImageBounded(chan, msg.messageId, img.fileKey);
              const admit = await admitImage(ctx, gateProvider, gateModel, buf);
              admitResults.push(admit);
            } catch (e) {
              admitResults.push({ supported: false, refs: [], reason: (e as Error).message });
              ctx.logger?.warn?.("[connect-lark] image download failed: " + (e as Error).message);
            }
          }
          if (admitResults.some((r) => !r.supported)) {
            const reply = IMAGE_UNSUPPORTED_REPLY;
            Promise.resolve(chan.send(msg.chatId, { markdown: reply })).catch((e) => ctx.logger?.warn?.("[connect-lark] send failed: " + (e as Error).message));
            return;
          }
          content = buildImageContent(text, { supported: true, refs: admitResults.flatMap((r: any) => r.refs) }) as any;
        }

        try {
          const title = text.trim().replace(/\s+/g, " ").slice(0, 32) || "飞书消息";
          await runManager!.start(msg.chatId, content, { kind: "user" }, title);
        } catch (e) {
          ctx.logger?.error?.("[connect-lark] run failed: " + (e as Error).message);
          Promise.resolve(chan.send(msg.chatId, { markdown: "[connect-lark] 运行失败：" + (e as Error).message })).catch(() => {});
        }
      });

      // 6) 卡片回调：设置入口（open-settings / select 即选即生效 / cancel）—— Issue #17
      const cardActionHandler = async (evt: any) => {
        if (!currentAlive()) return;
        const chatId = evt.chatId;
        const openId = evt.operator?.openId ?? "";
        if (!passesWhitelist(plain, chatId, openId, chatTypeCache.get(chatId) ?? "group", managerOpenId)) {
          return { toast: { type: "error", content: "无权操作设置" } };
        }
        const option = evt.action?.option;
        // 控件标识解析：CardKit 2.0 select_static 回调不携带 action.name（组件 name 仅在
        // form 容器内生效）——behaviors 自定义回传参数 { value: 控件名 } 是可靠兜底。
        // action.value 形如 { value: "model" }（select）或 "open-settings"（button）。
        const rawActionValue = evt.action?.value;
        const behaviorName = typeof rawActionValue === "object" && rawActionValue !== null
          ? (rawActionValue as any).value
          : rawActionValue;
        const actionName = evt.action?.name;
        const controlName = (typeof actionName === "string" && actionName)
          ? actionName
          : (typeof behaviorName === "string" && behaviorName ? behaviorName : undefined);
        // P4：历史对话选择（选中即切换会话：下一条消息起在该会话上下文继续）
        if (controlName === "history") {
          if (typeof option !== "string" || option === "") return;
          if (!dedupClaim(evt.messageId + ":" + controlName + ":" + option)) return;
          // 校验该会话确实存在（本地查询，带超时兜底防回调挂起）
          // 用大 limit 取全集：卡片只展示最近 20 条，但被选中的会话可能已被挤出
          const listed = await withTimeout(listSessions(ctx, 10_000), 5_000);
          if (!listed.ok) return { toast: { type: "error", content: "会话列表加载超时，请重试" } };
          const chosen = listed.value.sessions.find((s) => s.sessionId === option);
          if (!chosen) return { toast: { type: "error", content: "该会话不存在或已不可用" } };
          // 切会话 = 换 sessionId（cwd 随会话出身属性走，不单独改 chat cwd）
          touchState(chatId, { sessionId: option });
          return { toast: { type: "success", content: "✅ 已切换到历史对话（下一条消息起在该会话继续，历史与设置保留）" } };
        }
        if (controlName === "workspace" || controlName === "model" || controlName === "effort" || controlName === "permission") {
          if (typeof option !== "string" || option === "") return;
          if (!dedupClaim(evt.messageId + ":" + controlName + ":" + option)) return;
          const prevDisplay = buildDisplay(chatId);
          const result = applySelect(chatId, controlName, option, openId);
          if (result.error) return { toast: { type: "error", content: result.error } };
          if (result.switchedWorkspace) {
            void sendWorkspaceSwitchedNotice(chan, chatId, result.workspaceTitle ?? "").catch(() => {});
          }
          if (result.pendingHigh) {
            return { toast: { type: "warning", content: "已选择高权限档，回复「确认」以应用（仅发起人，30s 内）" } };
          }
          if (!result.partial) return;
          // 强度校验：档位必须属于当前模型，否则 DSH 会拒绝（真机实证：
          // provider "agnes" model "agnes-3.0-flash" does not support reasoning effort "max"）。
          // 校验用「已生效配置 + 本次待写候选」的合并视图——不能只看配置：
          // 持久化是异步的（fire-and-forget），刚选的模型尚未落盘时按旧模型校验会误拒。
          if (controlName === "effort" && result.partial.reasoningEffort) {
            // 校验用该 chat 当前的模型视图（per-chat 状态；刚切的模型已反映）
            const st = chatState(chatId);
            const allowed = effortOptionsFor(settingsCardArgs(chatId, {
              provider: st.provider,
              model: st.model,
            })).map((o) => o.value);
            // 只有在「catalog 已知该模型的档位」时才拦截；catalog 缺失（未刷新/
            // 未知模型）时放行 —— 由 DSH 自己在请求时给出明确错误，比误拒更好。
            const knowsModel = allowed.length > 1;
            if (knowsModel && !allowed.includes(result.partial.reasoningEffort)) {
              return { toast: { type: "error", content: "当前模型不支持该思考强度，请先切换模型" } };
            }
          }
          // 一等公民：不写配置/patch/HMR。同步落 per-chat 状态（当前值立即反映）+
          // 后台写会话投影（agent.model.select / permissionPresets.set，失败发通知）。
          void applyDimension(chan, chatId, controlName, result.partial);
          const dimLabels: Record<string, string> = { workspace: "工作区", model: "模型", effort: "思考强度", permission: "权限" };
          const field: string = controlName;
          const prevLabel = (prevDisplay as any)?.[field] ?? "跟随 DSH 默认";
          const switchToast = { type: "success", content: prevLabel === nextLabelOf(field, result.partial)
            ? "✅ 已设置（本对话；会话级，重启保留）"
            : "✅ " + dimLabels[controlName] + "已切换：" + prevLabel + " → " + nextLabelOf(field, result.partial) + "（本对话；会话级，重启保留）" };
          // 模型切换：面板按新模型同步重建（档位立刻跟随所选模型）→ 就地返回卡片（零 await、零网络）
          let panel: object | undefined;
          if (controlName === "model" && result.partial.provider && result.partial.model) {
            // 换模型：强度清空（与 applySelect 的 partial 一致）——否则 initial_option 会指向
            // 旧模型的档位值，可能不在新模型的 options 里（独立审查 P1-2）。
            panel = rebuildReplyCard(chatId, {
              provider: result.partial.provider,
              model: result.partial.model,
              reasoningEffort: "",
            });
          } else {
            try { rebuildReplyCard(chatId); } catch (e) {
              ctx.logger?.warn?.("[connect-lark] reply card rebuild failed: " + (e as Error).message);
            }
          }
          return panel
            ? { toast: switchToast, card: { type: "raw", data: panel } }
            : { toast: switchToast };
        }
        // button 回调：action.value = { value: "open-settings" | "cancel-settings" }
        const rawValue = evt.action?.value;
        const kind = typeof rawValue === "object" && rawValue !== null ? (rawValue as any).value : rawValue;
        if (typeof kind !== "string" || kind.length === 0) return;
        if (!dedupClaim(evt.messageId + ":" + kind)) return;
        // 历史「取消」按钮（旧版选择卡）仍需响应
        if (kind === CANCEL_SETTINGS_VALUE) {
          return { toast: { type: "info", content: "已关闭" } };
        }
        // P4：历史对话卡 / 新对话按钮（按钮区顶部已做 dedupClaim，此处不再重复）
        if (kind === "open-history") {
          // 后台拉会话列表并发卡（回调只回 toast，重活 detach）
          void (async () => {
            try {
              const { sessions, total } = await listSessions(ctx);
              const currentId = chatState(chatId).sessionId;
              const card = buildHistoryCard(sessions, currentId, total);
              // 卡片发送失败要报**真实原因**；且必须留 markdown 兜底：
              // 飞书建卡在某些环境下会卡住（真机实测：选项过多 / 客户端过旧），
              // 这时至少把会话清单以文本给出，用户还能看到有哪些历史。
              let sent: { ok: boolean } | null = null;
              try {
                sent = await withTimeout(chan.send(chatId, { card }), 8_000);
              } catch (sendError) {
                ctx.logger?.warn?.("[connect-lark] history card send error: " + (sendError as Error).message);
                await sendHistoryFallback(chan, chatId, sessions, total, (sendError as Error).message);
                return;
              }
              if (!sent.ok) {
                ctx.logger?.warn?.("[connect-lark] history card send timed out (8s)");
                await sendHistoryFallback(chan, chatId, sessions, total, "发送超时");
                return;
              }
            } catch (e) {
              ctx.logger?.warn?.("[connect-lark] history card failed: " + (e as Error).message);
              void Promise.resolve(chan.send(chatId, { markdown: "⚠️ 历史会话列表加载失败：" + (e as Error).message })).catch(() => {});
            }
          })();
          return { toast: { type: "info", content: "正在加载历史对话…" } };
        }
        if (kind === "new-conversation") {
          // 后台开新会话（host-uuid）并记入 per-chat 状态；下一条消息起走新会话
          void (async () => {
            try {
              const cwd = currentCwd(chatId);
              const created = await ctx.sessionController.create({ cwd });
              const newId = created.sessionId;
              const ws = await ctx.workspaceRegistry?.resolveByPath?.(cwd);
              if (ws) { try { await ws.attachSession(newId); } catch { /* 归属失败不阻断 */ } }
              touchState(chatId, { sessionId: newId });
              await sendBounded(chan, chatId, "✅ 已开启**新对话**（空白会话）。**下一条消息起**在新上下文处理，之前的历史保留在原会话。");
            } catch (e) {
              ctx.logger?.warn?.("[connect-lark] new conversation failed: " + (e as Error).message);
              await sendBounded(chan, chatId, "⚠️ 新对话创建失败：" + (e as Error).message);
            }
          })();
          return { toast: { type: "info", content: "正在创建新对话…" } };
        }
        if (kind === "cancel-history") {
          return { toast: { type: "info", content: "已关闭" } };
        }
        // P5：审批按钮（approve:<callId> / reject:<callId>）
        if (kind.startsWith("approve:") || kind.startsWith("reject:")) {
          const callId = kind.slice(kind.indexOf(":") + 1);
          const pending = pendingApprovals.get(callId);
          if (!pending) return { toast: { type: "error", content: "审批已失效或已处理" } };
          pendingApprovals.delete(callId);
          const outcome = kind.startsWith("approve:") ? "allowed-once" : "rejected";
          pending.resolve(outcome);
          // 就地更新审批卡为终态（不消失、不撤回）
          if (pending.messageId) {
            void Promise.resolve(chan.updateCard(pending.messageId, buildApprovalFinalCard(pending.toolName, outcome)))
              .catch((e) => ctx.logger?.warn?.("[connect-lark] approval card final update failed: " + (e as Error).message));
          }
          return { toast: { type: "success", content: outcome === "allowed-once" ? "✅ 已同意" : "⛔ 已拒绝" } };
        }
        return;
      };
      unsubCardAction = chan.on("cardAction", cardActionHandler);

      // boot 时刷新设置数据（模型目录/权限档/工作区）。
      // 为什么必须在这里刷新：卡片切换会重载本 entry → 新实例的缓存是空的，
      // 而 refreshSettingsData 原本只在「回复结束」时调用 → 切换后面板没有模型/
      // 档位选项、强度校验还会误拒（真机实证 2026-11-15：切模型后选 medium 被拒）。
      void refreshSettingsData().catch(() => {});
      ctx.logger?.info?.("[connect-lark] ready");
    };

    const cleanup = async () => {
      generation++; // invalidate an in-flight boot before touching resources
      for (const unsub of unsubEvents) try { unsub(); } catch { /* already gone */ }
      unsubEvents = [];
      if (unsubMessage) try { unsubMessage(); } catch { /* already gone */ }
      unsubMessage = null;
      if (unsubCardAction) try { unsubCardAction(); } catch { /* already gone */ }
      unsubCardAction = null;
      const chan = channel;
      channel = null;
      const manager = runManager;
      runManager = null;
      // Let a running turn finish before disposing so a config save does not
      // cancel a reply mid-flight. Drain has a bounded timeout; what remains
      // is then cancelled and disposed.
      await Promise.resolve(manager?.drain(3000)).catch(() => {});
      const directory = directoryService;
      directoryService = null;
      await Promise.allSettled([
        chan ? Promise.resolve(chan.disconnect()) : Promise.resolve(),
        manager ? Promise.resolve(manager.disposeAll()) : Promise.resolve(),
        directory ? Promise.resolve(directory.close()) : Promise.resolve(),
      ]);
      sessionChat.clear();
      mediaRegistered.clear();
      // P5：清理未决审批（resolve 为 cancelled，不挂死 agent）
      for (const [, p] of pendingApprovals) {
        try { p.resolve("cancelled"); } catch { /* already settled */ }
      }
      pendingApprovals.clear();
    };

    const queueBoot = () => {
      transition = transition.then(async () => {
        await cleanup();
        if (!dead) await boot();
      }).catch((e) => {
        ctx.logger?.error?.("[connect-lark] boot failed: " + (e as Error).message);
      });
    };

    // 配置热更新分流（配置页编辑触发；卡片修改不写配置，走会话投影，不经过这里）：
    // - 连接级字段（appId/密钥/域名/所有权等）→ queueBoot 全量重连；
    // - 其余字段（如 defaultPath）→ 热应用：只更新 plain 快照，不重连
    //   （避免重连窗口丢失消息/回调）。provider/model/强度/权限四字段已退休
    //   （一等公民：由 per-chat 状态 + 会话投影承载），热应用后不再驱动会话行为；
    //   defaultPath 仍是「新对话起始工作区」的默认值，下一条新 chat 的消息即生效。
    const unsubVolatile = ctx.on("loader/volatile-update", (paths: readonly (readonly string[])[]) => {
      const fields = new Set((paths ?? []).map((p) => Array.isArray(p) ? p[p.length - 1] : String(p)));
      const RECONNECT_FIELDS = new Set(["enabled", "appId", "appSecretRef", "domain", "agentOwnership", "attachSessionId", "requireMention"]);
      const needsReconnect = [...fields].some((f) => RECONNECT_FIELDS.has(f));
      if (needsReconnect) { queueBoot(); return; }
      plain = plainConfig(config); // 热应用：刷新插件配置快照（resolveAgent/面板读取）
      ctx.logger?.info?.("[connect-lark] hot config update (no reconnect): " + [...fields].join(", "));
    });

    // P5 审批监听器在 apply() 顶层注册（见下），此处不再重复注册。

    queueBoot();

    return async () => { // disposer
      dead = true;
      try { unsubVolatile(); } catch { /* already gone */ }
      transition = transition.then(cleanup).catch(() => {});
      await transition;
      ctx.logger?.info?.("[connect-lark] disposed");
    };
  });

  // ---- P5 审批：宿主级 waterfall 事件（apply 顶层注册，跨 boot/cleanup 存活）----
  // 只答自己 agent 的审批（sessionChat 里有该 sessionId → chatId 的归属）；
  // 其他 agent（如 Web 会话）的审批交给其他 answerer（next()）。
  //
  // **必须 prepend**：approval/request 是 waterfall，先问先答者胜。宿主自带的
  // Web/remote answerer（dsh-api-remotes 把审批转发给 Web UI 客户端）注册更早，
  // 一旦它挂起等人点，插件就永远轮不到 —— 真机实测：审批请求已产生
  // （会话日志有 approval/asked、无 decided），但飞书收不到审批卡。
  // prepend 把本监听器插到 waterfall 最前，抢在 Web answerer 之前。
  ctx.on("approval/request", (req: any, next: () => Promise<"allowed-once" | "rejected" | "cancelled">) => {
      const sid = req?.agent?.session?.id;
      const chatId = sessionChat.get(sid);
      if (!chatId) return next(); // 非本插件 agent → 不干预
      if (!channel) return Promise.resolve("cancelled"); // 通道未就绪 → 取消（不挂死 agent）
      const callId = req?.callId ?? "";
      return new Promise<"allowed-once" | "rejected" | "cancelled">((resolve) => {
        // 先清理过期审批（防残留）
        const now = Date.now();
        for (const [cid, p] of pendingApprovals) if (p.expiresAt <= now) pendingApprovals.delete(cid);
        pendingApprovals.set(callId, { resolve, chatId, messageId: "", toolName: req?.toolName ?? "", expiresAt: now + APPROVAL_TTL_MS });
        // 发审批卡（异步，不阻塞 listener 返回——Promise 已挂起等按钮）
        void (async () => {
          try {
            const sent = await withTimeout(channel!.send(chatId, { card: buildApprovalCard(req?.toolName ?? "", req?.reason ?? req?.displayReason?.en, callId) }), 15_000);
            if (sent.ok) {
              const mid = (sent.value as any)?.messageId;
              const pending = pendingApprovals.get(callId);
              if (pending) pending.messageId = mid ?? "";
            } else {
              // 发卡失败 → 直接取消（不挂死）
              const pending = pendingApprovals.get(callId);
              if (pending) { pendingApprovals.delete(callId); pending.resolve("cancelled"); }
            }
          } catch (e) {
            ctx.logger?.warn?.("[connect-lark] approval card send failed: " + (e as Error).message);
            const pending = pendingApprovals.get(callId);
            if (pending) { pendingApprovals.delete(callId); pending.resolve("cancelled"); }
          }
        })();
        // TTL 兜底：超时未点 → 取消（不挂死 agent）
        const timer = setTimeout(() => {
          const pending = pendingApprovals.get(callId);
          if (pending) { pendingApprovals.delete(callId); pending.resolve("cancelled"); }
        }, APPROVAL_TTL_MS);
        timer.unref?.();
      });
  }, { prepend: true });
}

// ---- Content extraction helpers ----

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("");
  }
  return "";
}

function extractImages(msg: any): Array<{ fileKey: string }> {
  const images: Array<{ fileKey: string }> = [];
  // SDK puts image resources in msg.resources as {type:"image", fileKey}.
  // content is a text string (e.g. "![image](key)").
  if (Array.isArray(msg?.resources)) {
    for (const r of msg.resources) {
      if (r?.type === "image" && r?.fileKey) images.push({ fileKey: r.fileKey });
    }
  }
  return images;
}

// ---- Re-exports (for tests + consumers) ----
export { richCard, streamMarkdown } from "./cards.js";
export {
  buildApprovalCard, buildApprovalFinalCard, buildHistoryCard, buildSettingsPanel,
  currentModelValue, effortOptions, modelOptions, settingsStatusLine,
  CANCEL_SETTINGS_VALUE, DEFAULT_OPTION_VALUE,
} from "./cards.js";
export type { HistorySessionOption, SettingsCardOptions, SettingsDisplay } from "./cards.js";
export { cwdTag } from "./overrides.js";
export { admitImage, buildImageContent, IMAGE_UNSUPPORTED_REPLY, downloadImageBounded, downloadInboundImage, MAX_IMAGE_BYTES, FEISHU_CDN_HOSTS } from "./images.js";
export { RunManager } from "./run.js";
export { fetchDirectoryUsers, listDirectoryUsers } from "./users.js";
export type { DirectoryUser, DirectoryResult } from "./users.js";
export { startDirectoryService, DIRECTORY_PORT } from "./directory-service.js";
export type { DirectoryService } from "./directory-service.js";
export type { RunSlot, RunState, RunManagerOptions } from "./run.js";

// ---- Contract notes ----

export const CONTRACT_NOTES = {
  createAgent: "ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model } })",
  modelOverride: "agent.model.select({ provider, model, reasoningEffort }) — 纯会话投影；禁 sessionController.selectModel（其实现会 agentDefaultModel.saveSelection 写全局默认）",
  settingsCard: "chan.send(chatId, { card }) 发配置卡；select_static 回调 action.name/action.option；CardActionResponse 就地更新 { card: { type: 'raw', data } }",
  userMessage: "createUserMessage({ content, source: { kind: \"user\" } }) from @deepseek-ai/dsh-llm",
  drive: "handle.agent.followup(message) — AgentHandle has no followup(); returns void",
  events: "agent/assistant-stream, agent/inbox/claimed, agent/error, session/event turn/start + turn/end",
  visualGate: "await ctx.llm.resolveModelInfo(provider, model, signal); guard undefined inputModalities",
  credentialField: "z.string().role(\"credential-ref\").default(...).volatile(), then credentialRef(...)",
  parsedUnwrap: "plainConfig(parsed) before reading any field — volatile fields are wrapper objects",
  failClosed: "throw on unusable ref name / blank resolved value; never return an empty secret",
  whitelistFailClosed: "accessMode=app (default) defers to the Feishu app scope; accessMode=list allows only the grants plus the tenant manager",
  streaming: "channel.stream(to, { markdown: async (c) => { c.append(delta) } }) — SDK-owned CardKit",
};
