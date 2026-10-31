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

import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createLarkChannel, type LarkChannel } from "@larksuite/channel";
import { richCard, streamMarkdown } from "./cards.js";
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

/** Create a per-chat agent, reusing live agents and resuming persisted sessions. */
export async function createOrResumeAgent(ctx: AnyCtx, sessionId: string, meta: { cwd?: string }, agentOptions: unknown, permissionPreset = ""): Promise<{ agent: any; sessionId: string; handle: any }> {
  const applyPreset = (agent: any) => {
    if (permissionPreset) ctx.permissionPresets.set(agent.session, permissionPreset);
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
  opts: { final?: boolean; legacyThinking?: boolean } = {},
): Promise<void> {
  if (!slot.streamController) return;
  const lines: string[] = [];
  const thinkingQuoted = () => slot.thinkingText.split("\n").map((line) => "> " + line).join("\n");
  const showThinking = thinkingPolicy === "cot-visible" && Boolean(slot.thinkingText);
  const bodyStarted = Boolean(slot.accumulatedText) || Boolean(opts.final);
  // 状态行：生成中（含用时，工具执行期间由心跳刷新）/ 已完成
  const elapsed = slot.runStartedAt ? Math.max(1, Math.round((Date.now() - slot.runStartedAt) / 1000)) : 0;
  const status = slot.failedWith ? ""
    : opts.final ? "✅ **已完成** —— 可以继续发送消息"
    : `⏳ **正在生成中** · 已用时 ${elapsed}s（思考与工具执行见下方，无需等待）`;
  let panels: Array<{ title: string; content: string; expanded?: boolean }> | undefined;
  if (slot.failedWith) {
    lines.push("**" + friendlyRunFailure(slot.failedWith) + "**");
  } else if (showThinking && !opts.legacyThinking) {
    const body = slot.thinkingText.length > FINAL_THINKING_TAIL
      ? "…（仅保留最近 " + FINAL_THINKING_TAIL + " 字，完整过程见会话）\n" + slot.thinkingText.slice(-FINAL_THINKING_TAIL)
      : slot.thinkingText;
    // 思考面板默认展开（用户要求）；正文开始后折叠的需求由用户手动收起满足
    panels = [{ title: "思考过程", content: thinkingQuoted(), expanded: true }];
    if (slot.accumulatedText) lines.push(slot.accumulatedText);
    else if (opts.final) lines.push("本次回复没有文本输出。");
  } else if (showThinking) {
    // 折叠面板被飞书拒绝时的回退版式：思考同样在正文上方
    lines.push("**思考过程**", thinkingQuoted(), "---", slot.accumulatedText || "正在生成回复…");
  } else if (slot.accumulatedText) {
    lines.push(slot.accumulatedText);
  } else if (opts.final) {
    lines.push("本次回复没有文本输出。");
  }
  const timestamp = new Date().toISOString();
  await slot.streamController.update(richCard({
    title: "DSH 回复",
    color: opts.final ? "green" : "blue",
    status,
    lines,
    panels,
    note: "connect-lark · by @oh-summy · " + timestamp,
    buttons: [{ text: "dsh-nano-market", url: "https://github.com/oh-summy/dsh-nano-market" }],
  }));
}

/** 终稿更新：先试折叠面板版式，被飞书拒绝时回退旧版引用块。 */
async function finalizeRunCard(slot: RunSlot, thinkingPolicy: ResolvedConfig["thinkingPolicy"]): Promise<void> {
  if (!slot.streamController) return;
  try {
    await updateRunCard(slot, thinkingPolicy, { final: true });
  } catch (panelError) {
    try { await updateRunCard(slot, thinkingPolicy, { final: true, legacyThinking: true }); }
    catch { throw panelError; }
  }
}

// ---- apply() ----

export function apply(ctx: AnyCtx, config: Config | ParsedConfig = {}) {
  let plain = plainConfig(config);
  let channel: LarkChannel | null = null;
  let runManager: RunManager | null = null;
  let unsubMessage: (() => void) | null = null;
  let directoryService: DirectoryService | null = null;
  // 租户管理员（应用的可用范围里的 owner）自动放行，不必手填 open_id。
  let managerOpenId = "";
  let unsubEvents: Array<() => void> = [];
  let generation = 0;
  let transition: Promise<void> = Promise.resolve();

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
          // Reuse existing agent from slot if already created (owned-per-chat).
          const existing = runManager?.getSlot(chatId);
          const present = async (sessionId: string) => {
            if (existing?.titleSet || plain.agentOwnership !== "owned-per-chat") return;
            try {
              const cwd = plain.defaultPath || process.cwd();
              const workspace = ctx.workspaceRegistry.list().find((item: any) => item.path === cwd);
              if (workspace) await workspace.attachSession(sessionId);
              if (title) await ctx.sessionController.rename({ sessionId, title });
              if (existing) existing.titleSet = true;
            } catch (error) {
              ctx.logger?.warn?.("[connect-lark] session presentation failed: " + (error as Error).message);
            }
          };
          if (existing?.agent && existing?.sessionId) {
            await present(existing.sessionId);
            return { agent: existing.agent, sessionId: existing.sessionId, handle: existing.handle };
          }
          if (plain.agentOwnership === "owned-per-chat") {
            // 会话 ID 带默认工作区指纹：cwd 是会话的出身属性，resume 不改出身——
            // 改默认工作区必须换新会话才能生效。指纹用简单多项式即可（只做缓存失效）。
            const cwdTag = (() => {
              const path = plain.defaultPath || "";
              if (!path) return "";
              let h = 5381;
              for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
              return "@" + h.toString(36);
            })();
            const sessionId = "connect-lark:" + chatId + cwdTag;
            const catalog = await ctx.sessionController.modelCatalog();
            const agentOptions = resolveAgentModelOptions(plain, catalog);
            const { agent, sessionId: resolvedSessionId, handle } = await createOrResumeAgent(
              ctx,
              sessionId,
              { cwd: plain.defaultPath || undefined },
              agentOptions,
              plain.permissionPreset,
            );
            await present(resolvedSessionId);
            return { agent, sessionId: resolvedSessionId, handle };
          }
          // attach-gui
          if (!plain.attachSessionId) {
            throw new Error("[connect-lark] attach-gui requires attachSessionId");
          }
          const agent = ctx.agents.get(plain.attachSessionId);
          if (!agent) throw new Error("[connect-lark] attachSessionId not found in agent registry");
          // Do NOT apply permissionPreset here: attach-gui shares the host GUI
          // session, and overriding it would change the user's own agent.
          return { agent, sessionId: plain.attachSessionId, handle: null };
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
            try {
              await finalizeRunCard(slot, plain.thinkingPolicy);
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

        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text) return;

        // Handle images.
        // content must be ContentBlock[] (not raw string) per UserMessage contract.
        let content: unknown = [{ type: "text", text }];
        const images = extractImages(msg);
        if (images.length > 0) {
          // Gate against the model this chat will actually use. attach-gui lets
          // the host pick the model, so skip the gate there.
          let gateProvider = plain.provider;
          let gateModel = plain.model;
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

      ctx.logger?.info?.("[connect-lark] ready");
    };

    const cleanup = async () => {
      generation++; // invalidate an in-flight boot before touching resources
      for (const unsub of unsubEvents) try { unsub(); } catch { /* already gone */ }
      unsubEvents = [];
      if (unsubMessage) try { unsubMessage(); } catch { /* already gone */ }
      unsubMessage = null;
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
    };

    const queueBoot = () => {
      transition = transition.then(async () => {
        await cleanup();
        if (!dead) await boot();
      }).catch((e) => {
        ctx.logger?.error?.("[connect-lark] boot failed: " + (e as Error).message);
      });
    };

    const unsubVolatile = ctx.on("loader/volatile-update", queueBoot);
    queueBoot();

    return async () => { // disposer
      dead = true;
      try { unsubVolatile(); } catch { /* already gone */ }
      transition = transition.then(cleanup).catch(() => {});
      await transition;
      ctx.logger?.info?.("[connect-lark] disposed");
    };
  });
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
