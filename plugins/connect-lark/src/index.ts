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
import { admitImage, buildImageContent, IMAGE_UNSUPPORTED_REPLY, downloadInboundImage } from "./images.js";

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
  requireMention: z.boolean().default(true).volatile().comment("群聊需 @ 机器人才触发（channel policy 已托管，勿重复实现）"),
  agentOwnership: z.union(["owned-per-chat", "attach-gui"]).default("owned-per-chat").volatile().comment("agent 所有权：默认每个聊天独立 agent；attach-gui 仅高级场景使用"),
  attachSessionId: z.string().default("").volatile().comment("attach-gui 时的目标 session id（无全局 current agent 可读）"),
  provider: z.string().default("").volatile().comment("owned-per-chat 时必填；默认空串是占位"),
  model: z.string().default("").volatile().comment("owned-per-chat 时必填"),
  senderAllowlist: z.array(z.string()).default([]).volatile().comment("私聊用户限制；留空允许所有私聊用户"),
  groupAllowlist: z.array(z.string()).default([]).volatile().comment("群聊限制；留空允许所有群聊"),
  thinkingPolicy: z.union(["cot-visible", "cot-discard", "stream-only"]).default("cot-visible").volatile().comment("思考展示：cot-visible=在卡片中显示思考过程；cot-discard/stream-only=不显示"),
  reasoningEffort: z.string().default("").volatile().comment("思考强度；留空跟随 DSH 当前模型默认配置"),
  permissionPreset: z.string().default("").volatile().comment("权限模式；留空跟随 DSH 默认，支持 read-only/workspace-write/danger-full-access/auto"),
});

type AnyCtx = any;

// ---- Helpers ----

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

export function passesWhitelist(plain: ResolvedConfig, chatId: string, senderId: string, chatType: "p2p" | "group" = "p2p"): boolean {
  // Feishu app permissions are the default boundary. Optional lists only
  // narrow their own chat kind; an empty list never blocks the other kind.
  if (chatType === "group") {
    return plain.groupAllowlist.length === 0 || plain.groupAllowlist.includes(chatId);
  }
  return plain.senderAllowlist.length === 0 || plain.senderAllowlist.includes(senderId);
}

// ---- (DeltaQueue removed — streaming is handled via onDelta callback) ----

class DeltaQueue {
  private resolver: ((d: string | null) => void) | null = null;
  private pending: string | null = null;
  private closed = false;

  push(delta: string): void {
    if (this.closed) return;
    if (this.resolver) {
      this.resolver(delta);
      this.resolver = null;
    } else {
      this.pending = delta;
    }
  }

  async next(): Promise<string | null> {
    if (this.pending !== null) {
      const d = this.pending;
      this.pending = null;
      return d;
    }
    if (this.closed) return null;
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  close(): void {
    this.closed = true;
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
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
export async function createOrResumeAgent(ctx: AnyCtx, sessionId: string, meta: { cwd?: string }, agentOptions: unknown, permissionPreset = ""): Promise<{ agent: any; handle: any }> {
  const applyPreset = (agent: any) => {
    if (permissionPreset) ctx.permissionPresets.set(agent.session, permissionPreset);
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const live = ctx.agents.get(sessionId);
    if (live) {
      applyPreset(live);
      return { agent: live, handle: null };
    }
    try {
      const handle = await ctx.agents.create({ sessionId, meta, agentOptions });
      applyPreset(handle.agent);
      return { agent: handle.agent, handle };
    } catch (error) {
      if (!/already exists|already registered|active write handle/i.test((error as Error).message)) throw error;
      if (attempt < 3) {
        // The previous AgentHandle may still be releasing its write handle.
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions });
      applyPreset(handle.agent);
      return { agent: handle.agent, handle };
    }
  }
  throw new Error("unreachable");
}

/** Update one streaming rich card with the latest answer and optional CoT. */
async function updateRunCard(slot: RunSlot, thinkingPolicy: ResolvedConfig["thinkingPolicy"]): Promise<void> {
  if (!slot.streamController) return;
  const lines: string[] = [];
  if (slot.failedWith) lines.push("**运行失败：** " + slot.failedWith.message);
  else lines.push(slot.accumulatedText || "正在生成回复…");
  if (thinkingPolicy === "cot-visible" && slot.thinkingText) {
    lines.push("---", "**思考过程**");
    lines.push(slot.thinkingText.split("\n").map((line) => "> " + line).join("\n"));
  }
  const note = slot.failedWith ? "运行失败" : slot.state === "done" ? "已完成" : "正在生成…";
  await slot.streamController.update(richCard({
    title: "DSH 回复",
    color: "blue",
    lines,
    note: "DeepSeek Harness · connect-lark · " + note,
    buttons: [{ text: "GitHub 仓库", url: "https://github.com/oh-summy/dsh-nano-market" }],
  }));
}

// ---- apply() ----

export function apply(ctx: AnyCtx, config: Config | ParsedConfig = {}) {
  let plain = plainConfig(config);
  let channel: LarkChannel | null = null;
  let runManager: RunManager | null = null;
  let unsubMessage: (() => void) | null = null;
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
        domain: plain.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
        // Group messages always require an @mention; this is not user-configurable.
        policy: { requireMention: true },
        safety: { chatQueue: { enabled: true } },
      });
      channel = chan;
      try {
        await chan.connect();
      } catch (e) {
        ctx.logger?.error?.("[connect-lark] channel connect failed: " + (e as Error).message);
        throw e;
      }
      if (!currentAlive()) { try { await chan.disconnect(); } catch { /* gone */ } return; }
      ctx.logger?.info?.("[connect-lark] channel connected");

      // 4) Create run manager.
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
            const sessionId = "connect-lark:" + chatId;
            const catalog = await ctx.sessionController.modelCatalog();
            const agentOptions = resolveAgentModelOptions(plain, catalog);
            const { agent, handle } = await createOrResumeAgent(
              ctx,
              sessionId,
              { cwd: plain.defaultPath || undefined },
              agentOptions,
              plain.permissionPreset,
            );
            await present(sessionId);
            return { agent, sessionId, handle };
          }
          // attach-gui
          if (!plain.attachSessionId) {
            throw new Error("[connect-lark] attach-gui requires attachSessionId");
          }
          const agent = ctx.agents.get(plain.attachSessionId);
          if (!agent) throw new Error("[connect-lark] attachSessionId not found in agent registry");
          return { agent, sessionId: plain.attachSessionId, handle: null };
        },
        buildMessage: (content: any, source: any) => buildUserMessage(content, source),
        subscribe: (agent, targetSessionId, onDelta, onTurnEnd, onError) => {
          // Track subscriptions for cleanup. The returned unsub removes them
          // from this array so it doesn't grow unbounded across runs.
          const track = (fn: () => void) => {
            unsubEvents.push(fn);
            return fn;
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
        onStart: (slot) => {
          const done = new Promise<void>((resolve) => { slot.streamDone = resolve; });
          slot.streamReady = new Promise<void>((resolve) => { slot.streamReadyResolve = resolve; });
          slot.streamPromise = chan.stream(slot.chatId, {
            card: {
              initial: richCard({
                title: "DSH 回复",
                color: "blue",
                lines: ["正在连接 DSH Agent…"],
                note: "DeepSeek Harness · connect-lark",
                buttons: [{ text: "GitHub 仓库", url: "https://github.com/oh-summy/dsh-nano-market" }],
              }),
              producer: async (controller) => {
                slot.streamController = controller;
                slot.streamReadyResolve?.();
                await done;
              },
            },
          });
          Promise.resolve(slot.streamPromise).catch((e) => {
            slot.streamFailed = e as Error;
            ctx.logger?.warn?.("[connect-lark] stream failed: " + (e as Error).message);
          });
        },
        onDelta: (slot) => {
          void updateRunCard(slot, plain.thinkingPolicy).catch((e) => ctx.logger?.warn?.("[connect-lark] card update failed: " + (e as Error).message));
        },
        onThinking: (slot) => {
          void updateRunCard(slot, plain.thinkingPolicy).catch((e) => ctx.logger?.warn?.("[connect-lark] card update failed: " + (e as Error).message));
        },
        onComplete: (slot) => {
          void (async () => {
            try {
              if (!slot.streamController && !slot.streamFailed) {
                // Let card creation finish briefly before deciding to fall back;
                // otherwise a slow create could cause a duplicate text + card reply.
                await Promise.race([
                  slot.streamReady ?? Promise.resolve(),
                  new Promise((resolve) => setTimeout(resolve, 1000)),
                ]);
              }
              if (slot.streamFailed || !slot.streamController) {
                const reply = slot.accumulatedText || (slot.failedWith ? "[connect-lark] 运行失败：" + slot.failedWith.message : "");
                if (reply) await chan.send(slot.chatId, { markdown: reply });
                return;
              }
              try {
                await updateRunCard(slot, plain.thinkingPolicy);
              } catch (e) {
                const reply = slot.accumulatedText || (slot.failedWith ? "[connect-lark] 运行失败：" + slot.failedWith.message : "");
                if (reply) await chan.send(slot.chatId, { markdown: reply });
              }
            } finally {
              slot.streamDone?.();
            }
          })().catch((e) => ctx.logger?.warn?.("[connect-lark] reply failed: " + (e as Error).message));
        },
      });

      // 5) Subscribe to messages.
      unsubMessage = chan.on("message", async (msg: any) => {
        if (!currentAlive()) return;
        if (!passesWhitelist(plain, msg.chatId, msg.senderId, msg.chatType)) return;

        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text) return;

        // Handle images.
        // content must be ContentBlock[] (not raw string) per UserMessage contract.
        let content: unknown = [{ type: "text", text }];
        const images = extractImages(msg);
        if (images.length > 0) {
          const admitResults = [];
          for (const img of images) {
            try {
              // channel.downloadResource downloads by fileKey (SDK-owned).
              const buf = await chan.downloadResource(msg.messageId, img.fileKey, "image") as Buffer;
              // In attach-gui mode, provider/model may be empty (host default).
              // When route is unknown, skip the gate — the host agent decides.
              // When route is known, gate normally.
              let admit;
              if (!plain.provider || !plain.model) {
                // attach-gui without explicit route: pass through without gate.
                admit = { supported: true, refs: [{ _passthrough: true }], reason: "attach-gui passthrough" };
              } else {
                admit = await admitImage(ctx, plain.provider, plain.model, buf);
              }
              admitResults.push(admit);
            } catch (e) {
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
      await Promise.allSettled([
        chan ? Promise.resolve(chan.disconnect()) : Promise.resolve(),
        manager ? Promise.resolve(manager.disposeAll()) : Promise.resolve(),
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
export { richCard, streamMarkdown, streamRichCard } from "./cards.js";
export { admitImage, buildImageContent, IMAGE_UNSUPPORTED_REPLY, downloadInboundImage, MAX_IMAGE_BYTES, FEISHU_CDN_HOSTS } from "./images.js";
export { RunManager } from "./run.js";
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
  whitelistFailClosed: "empty senderAllowlist + empty groupAllowlist = deny all messages",
  streaming: "channel.stream(to, { markdown: async (c) => { c.append(delta) } }) — SDK-owned CardKit",
};
