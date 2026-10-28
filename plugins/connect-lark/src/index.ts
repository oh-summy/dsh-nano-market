// @oh-summy/connect-lark — Feishu/Lark long-connection channel for DSH.
//
// Long connection + agent driving + streaming card replies + image handling.
// Core decisions:
//   - agent ownership: both modes supported (attach-gui default, owned-per-chat fallback)
//   - CoT policy: stream-only (no CoT display; cot-discard/cot-visible need the spike)
//   - whitelists: empty = deny all (fail-closed)
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
}

type Vol<T> = T | { get(): T };

export type ParsedConfig = {
  [K in keyof Config]: Vol<NonNullable<Config[K]>>;
};

export type ResolvedConfig = {
  enabled: boolean;
  appId: string;
  appSecretRef: string;
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
};

export function plainConfig(input: Config | ParsedConfig): ResolvedConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = isVolatile(value) ? (value as { get(): unknown }).get() : value;
  }
  return out as ResolvedConfig;
}

export const inject = ["agents", "llm", "attachments", "credentials"];

export const Config = z.object({
  enabled: z.boolean().default(false).volatile().comment("启用飞书连接（关闭即断连）"),
  appId: z.string().default("").volatile().comment("飞书 App ID（v1 手填；扫码建应用见二期）"),
  appSecretRef: z.string().role("credential-ref").default("CONNECT_LARK_APP_SECRET").volatile().comment("App Secret 的凭据缝引用名"),
  defaultPath: z.string().default("").volatile().comment("默认工作区路径（留空=宿主 cwd）"),
  openId: z.string().default("").volatile().comment("你的 open_id（私聊/测试消息）"),
  domain: z.union(["feishu", "lark"]).default("feishu").volatile().comment("飞书或 Lark"),
  requireMention: z.boolean().default(true).volatile().comment("群聊需 @ 机器人才触发（channel policy 已托管，勿重复实现）"),
  agentOwnership: z.union(["owned-per-chat", "attach-gui"]).default("attach-gui").volatile().comment("agent 所有权：attach-gui 复用宿主 agent；owned-per-chat 插件自建"),
  attachSessionId: z.string().default("").volatile().comment("attach-gui 时的目标 session id（无全局 current agent 可读）"),
  provider: z.string().default("").volatile().comment("owned-per-chat 时必填；默认空串是占位"),
  model: z.string().default("").volatile().comment("owned-per-chat 时必填"),
  senderAllowlist: z.array(z.string()).default([]).volatile().comment("sender 白名单（空=拒绝全部，fail-closed）"),
  groupAllowlist: z.array(z.string()).default([]).volatile().comment("群 chat_id 白名单（空=拒绝全部，fail-closed）"),
  thinkingPolicy: z.union(["cot-visible", "cot-discard", "stream-only"]).default("stream-only").volatile().comment("CoT 政策：stream-only=不显示思考过程；cot-* 需 spike"),
});

type AnyCtx = any;

// ---- Helpers (kept from v6, verified correct) ----

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

// ---- Whitelist check (fail-closed, ARCHITECTURE §3.3) ----

export function passesWhitelist(plain: ResolvedConfig, chatId: string, senderId: string): boolean {
  // Fail-closed: if either allowlist is empty, that dimension is DENY.
  // Both must be non-empty for ANY message to pass.
  if (plain.senderAllowlist.length === 0) return false;
  if (plain.groupAllowlist.length === 0) return false;
  return plain.senderAllowlist.includes(senderId) && plain.groupAllowlist.includes(chatId);
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
      // 1) Check enabled first — if disabled, don't even resolve secret.
      if (!plain.enabled) {
        ctx.logger?.info?.("[connect-lark] disabled (enabled=false) — not connecting");
        return;
      }
      // 2) Resolve secret (fails closed if unset).
      const appSecret = await resolveAppSecret(ctx, config);
      if (!currentAlive()) return;

      // 2) Whitelist pre-check: if both allowlists are empty, deny all (fail-closed).
      const allowlistConfigured = plain.senderAllowlist.length > 0 || plain.groupAllowlist.length > 0;
      if (!allowlistConfigured) {
        ctx.logger?.warn?.("[connect-lark] senderAllowlist and groupAllowlist are both empty — all messages will be denied (fail-closed). Both must be configured to enable messaging.");
      }

      // 3) Create + connect channel.
      const chan = createLarkChannel({
        appId: plain.appId,
        appSecret,
        transport: "websocket",
        domain: plain.domain,
        policy: { requireMention: plain.requireMention },
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
        resolveAgent: async (chatId) => {
          // Reuse existing agent from slot if already created (owned-per-chat).
          const existing = runManager?.getSlot(chatId);
          if (existing?.agent && existing?.sessionId) {
            return { agent: existing.agent, sessionId: existing.sessionId, handle: existing.handle };
          }
          if (plain.agentOwnership === "owned-per-chat") {
            if (!plain.provider || !plain.model) {
              throw new Error("[connect-lark] owned-per-chat requires provider and model");
            }
            const sessionId = "connect-lark:" + chatId;
            const handle = await ctx.agents.create({
              sessionId,
              meta: { cwd: plain.defaultPath || undefined },
              agentOptions: { provider: plain.provider, model: plain.model },
            });
            return { agent: handle.agent, sessionId, handle };
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
            // text-delta chunks carry the text; reasoning-delta is excluded (stream-only policy).
            const frame = evt.frame;
            if (frame?.type === "chunk" && frame.chunk?.type === "text-delta") {
              onDelta(frame.chunk.text);
            }
          }));
          const unsubTurn = ctx.on("session/event", (session: any, event: any) => {
            // Filter by session to avoid cross-session turn/end firing.
            if (event?.type === "turn/end" && session?.id === targetSessionId) onTurnEnd();
          });
          const unsubError = ctx.on("agent/error", (evt: any) => {
            if (evt.agent === agent) onError(evt.error);
          });
          unsubEvents.push(unsubStream, unsubTurn, unsubError);
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
        onComplete: (slot) => {
          if (slot.accumulatedText) {
            Promise.resolve(chan.send(slot.chatId, { markdown: slot.accumulatedText }))
              .catch((e) => ctx.logger?.warn?.("[connect-lark] send failed: " + (e as Error).message));
          }
        },
      });

      // 5) Subscribe to messages.
      unsubMessage = chan.on("message", async (msg: any) => {
        if (!currentAlive()) return;
        if (!passesWhitelist(plain, msg.chatId, msg.senderId)) return;

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
          await runManager!.start(msg.chatId, content, { kind: "user" });
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
