import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createLarkChannel } from "@larksuite/channel";
// src/run.ts
/**
* Manages per-chat run slots with ordered execution and cancellation.
*/
var RunManager = class {
	slots = /* @__PURE__ */ new Map();
	opts;
	unsubs = /* @__PURE__ */ new Map();
	constructor(opts) {
		this.opts = opts;
	}
	/** Get or create a run slot for a chat. */
	getOrCreate(chatId) {
		let slot = this.slots.get(chatId);
		if (!slot) {
			slot = {
				chatId,
				agent: null,
				sessionId: "",
				handle: null,
				state: "idle",
				cancelController: null,
				streamMessageId: null,
				accumulatedText: "",
				turnId: null,
				pending: []
			};
			this.slots.set(chatId, slot);
		}
		return slot;
	}
	/** Get a slot by chatId (for reuse/diagnostics). */
	getSlot(chatId) {
		return this.slots.get(chatId);
	}
	/** Check if a chat has an active run. */
	isRunning(chatId) {
		const slot = this.slots.get(chatId);
		return slot?.state === "running" || slot?.state === "cancelling";
	}
	/**
	* Start a run for a chat (or resume if one is already active).
	* Returns the slot; the actual work happens via subscribe + followup.
	*/
	async start(chatId, content, source) {
		const slot = this.getOrCreate(chatId);
		if (this.isRunning(chatId)) {
			slot.pending.push({
				content,
				source
			});
			return slot;
		}
		const { agent, sessionId, handle } = await this.opts.resolveAgent(chatId);
		slot.agent = agent;
		slot.handle = handle;
		slot.sessionId = sessionId;
		const unsub = this.opts.subscribe(agent, sessionId, (delta) => {
			slot.accumulatedText += delta;
		}, () => {
			this.complete(chatId);
		}, (e) => {
			this.fail(chatId, e);
		});
		this.unsubs.set(chatId, unsub);
		slot.state = "running";
		slot.cancelController = new AbortController();
		slot.accumulatedText = "";
		slot.turnId = (slot.turnId ?? 0) + 1;
		this.opts.followup(agent, this.opts.buildMessage(content, source));
		return slot;
	}
	/** Cancel the current run for a chat (does NOT dispose the agent).
	* Adds a watchdog: if turn/end doesn't arrive within 30s after abort,
	* force-transition to done so subsequent messages aren't stuck forever.
	*/
	cancel(chatId) {
		const slot = this.slots.get(chatId);
		if (!slot || slot.state !== "running") return;
		slot.state = "cancelling";
		slot.cancelController?.abort();
		setTimeout(() => {
			const s = this.slots.get(chatId);
			if (s && s.state === "cancelling") this.complete(chatId);
		}, 3e4).unref?.();
	}
	/** Mark a run as complete and process the next queued message. */
	complete(chatId) {
		const slot = this.slots.get(chatId);
		if (!slot || slot.state !== "running" && slot.state !== "cancelling") return;
		slot.state = "done";
		this.cleanup(chatId);
		this.opts.onComplete?.(slot);
		if (slot.pending.length > 0) {
			const next = slot.pending.shift();
			this.start(chatId, next.content, next.source);
		}
	}
	/** Mark a run as failed and reset state. */
	fail(chatId, error) {
		const slot = this.slots.get(chatId);
		if (!slot || slot.state === "done") return;
		slot.state = "done";
		slot.failedWith = error;
		this.cleanup(chatId);
		this.opts.onComplete?.(slot);
		if (slot.pending.length > 0) {
			const next = slot.pending.shift();
			this.start(chatId, next.content, next.source);
		}
	}
	/** Dispose all owned agents and clear all slots. */
	cleanup(chatId) {
		const unsub = this.unsubs.get(chatId);
		if (unsub) try {
			unsub();
		} catch {}
		this.unsubs.delete(chatId);
	}
	async disposeAll() {
		const failures = [];
		for (const slot of this.slots.values()) try {
			slot.cancelController?.abort();
		} catch {}
		for (const chatId of this.slots.keys()) this.cleanup(chatId);
		for (const slot of this.slots.values()) {
			try {
				if (slot.handle) await slot.handle.dispose();
			} catch (e) {
				failures.push(e);
			}
			slot.state = "idle";
			slot.handle = null;
			slot.cancelController = null;
		}
		this.slots.clear();
		if (failures.length > 0) throw new Error("RunManager disposal failed: " + failures.map((e) => e.message).join("; "));
	}
	/** Get all active slots (for diagnostics/tests). */
	list() {
		return [...this.slots.values()];
	}
};
// src/images.ts
/** Maximum image bytes to admit (20 MiB default, same as dsh-acp). */
const MAX_IMAGE_BYTES = 20971520;
/**
* Admit an image for the current model route.
*
* @param ctx - DSH context (needs llm + attachments services).
* @param provider - exact provider id.
* @param model - exact model id.
* @param buffer - raw image bytes.
* @param signal - cancellation signal.
* @returns admission result; never throws for "unsupported" (returns supported:false).
*/
async function admitImage(ctx, provider, model, buffer, signal) {
	let info;
	try {
		info = await ctx.llm.resolveModelInfo(provider, model, signal);
	} catch (e) {
		return {
			supported: false,
			refs: [],
			reason: "cannot verify model for image input: " + e.message
		};
	}
	signal?.throwIfAborted();
	if (info === void 0 || info === null) return {
		supported: false,
		refs: [],
		reason: "model info is undefined"
	};
	if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) return {
		supported: false,
		refs: [],
		reason: "model does not declare image input"
	};
	if (buffer.byteLength > 20971520) return {
		supported: false,
		refs: [],
		reason: "image exceeds 20971520 bytes"
	};
	const mediaType = detectImageMediaType(buffer);
	try {
		return {
			supported: true,
			refs: await ctx.attachments.saveImages([{
				data: buffer,
				mediaType
			}])
		};
	} catch (e) {
		return {
			supported: false,
			refs: [],
			reason: "saveImages failed: " + e.message
		};
	}
}
/**
* Detect image media type from magic bytes.
* Feishu/Lark inbound images are typically JPEG; we must not hardcode PNG
* because the host validates that declared mediaType matches actual bytes.
*/
function detectImageMediaType(buffer) {
	if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
	if (buffer.length >= 8 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) return "image/png";
	if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (buffer.length >= 6 && buffer.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
	return "image/png";
}
/** Honest fallback when image input is unsupported (ARCHITECTURE §3.1). */
const IMAGE_UNSUPPORTED_REPLY = "暂时不支持查看图片（当前模型路由未声明图像输入）。";
/**
* Build the content array for a user message, adding image blocks when admitted.
* Returns text-only content when unsupported.
*/
function buildImageContent(text, admit) {
	if (!admit.supported || admit.refs.length === 0) return [{
		type: "text",
		text
	}];
	const content = [{
		type: "text",
		text
	}];
	for (const ref of admit.refs) content.push({
		type: "image",
		attachment: ref
	});
	return content;
}
/**
* Inbound image download helper (SSRF-guarded).
*
* Only accepts https URLs from known Feishu CDN hosts. Never follows redirects
* to arbitrary hosts (privacy + SSRF risk, ARCHITECTURE §3.1).
*/
const FEISHU_CDN_HOSTS = /* @__PURE__ */ new Set(["lf3-cdn-tos.bytecdntp.com", "lf6-cdn-tos.bytecdntp.com"]);
async function downloadInboundImage(url, maxBytes = MAX_IMAGE_BYTES) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("invalid image URL: " + url);
	}
	if (parsed.protocol !== "https:") throw new Error("image URL must be https: got " + parsed.protocol);
	if (!FEISHU_CDN_HOSTS.has(parsed.hostname)) throw new Error("image URL host not in allowed CDN set: " + parsed.hostname);
	const res = await fetch(url, {
		redirect: "error",
		signal: AbortSignal.timeout(3e4)
	});
	if (!res.ok) throw new Error("image download HTTP " + res.status);
	const len = Number(res.headers.get("content-length") ?? 0);
	if (len > maxBytes) throw new Error("image exceeds " + maxBytes + " bytes (Content-Length " + len + ")");
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.byteLength > maxBytes) throw new Error("image exceeds " + maxBytes + " bytes");
	return buf;
}
// src/cards.ts
/**
* Build a CardKit JSON 2.0 object with header + body elements.
*
* This is the "raw CardKit JSON" path — the SDK does NOT own this structure.
* The caller must provide it (ARCHITECTURE §3.2).
*/
function richCard(opts) {
	const elements = [];
	for (const line of opts.lines) if (line === "---") elements.push({ tag: "hr" });
	else elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: line
		}
	});
	if (opts.buttons && opts.buttons.length > 0) {
		const actions = opts.buttons.map((b) => ({
			tag: "button",
			text: {
				tag: "plain_text",
				content: b.text
			},
			type: "default",
			...b.url ? { url: b.url } : {},
			...b.value ? { value: b.value } : {}
		}));
		elements.push({
			tag: "action",
			actions
		});
	}
	if (opts.note) elements.push({
		tag: "note",
		elements: [{
			tag: "plain_text",
			content: opts.note
		}]
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: opts.title
			},
			template: opts.color
		},
		body: { elements }
	};
}
/**
* Stream plain markdown to a chat via channel.stream().
*
* The SDK owns CardKit create + atomic update + finalize here — no raw JSON needed.
* Returns the SendResult so the caller can track the message ID.
*/
async function streamMarkdown(channel, to, getDelta) {
	return channel.stream(to, { markdown: async (c) => {
		while (true) {
			const delta = await getDelta();
			if (delta === null) break;
			if (delta.length > 0) c.append(delta);
		}
	} });
}
/**
* Stream a rich card via channel.stream({ card: { initial, producer } }).
*
* The caller provides the full card JSON; the SDK handles atomic updates.
*/
async function streamRichCard(channel, to, initial, getUpdate) {
	return channel.stream(to, { card: {
		initial,
		producer: async (c) => {
			while (true) {
				const update = await getUpdate();
				if (update === null) break;
				c.update(update);
			}
		}
	} });
}
// src/index.ts
function plainConfig(input) {
	const out = {};
	for (const [key, value] of Object.entries(input)) out[key] = isVolatile(value) ? value.get() : value;
	return out;
}
const inject = [
	"agents",
	"llm",
	"attachments",
	"credentials"
];
const Config = z.object({
	enabled: z.boolean().default(false).volatile().comment("启用飞书连接（关闭即断连）"),
	appId: z.string().default("").volatile().comment("飞书 App ID（v1 手填；扫码建应用见二期）"),
	appSecretRef: z.string().role("credential-ref").default("CONNECT_LARK_APP_SECRET").volatile().comment("App Secret 的凭据缝引用名"),
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
	thinkingPolicy: z.union([
		"cot-visible",
		"cot-discard",
		"stream-only"
	]).default("stream-only").volatile().comment("CoT 政策：当前仅实现 stream-only"),
	reasoningEffort: z.string().default("").volatile().comment("思考强度；留空跟随 DSH 当前模型默认配置")
});
async function resolveAppSecret(ctx, parsed) {
	const { appSecretRef } = plainConfig(parsed);
	if (typeof appSecretRef !== "string" || !isCredentialRefName(appSecretRef)) throw new Error("[connect-lark] appSecretRef " + String(appSecretRef) + " is not a valid credential reference name (expected a POSIX shell identifier such as CONNECT_LARK_APP_SECRET)");
	const ref = credentialRef(appSecretRef);
	const value = (await ctx.credentials.resolve(ref))?.value;
	if (typeof value !== "string" || value.trim() === "") throw new Error("[connect-lark] credential " + appSecretRef + " resolved to an unusable value (" + (value === null ? "null" : typeof value) + ") — set it to a non-blank string before enabling the Feishu connection");
	return value;
}
function buildUserMessage(content, source) {
	return createUserMessage({
		content,
		source: source ?? { kind: "user" }
	});
}
function passesWhitelist(plain, chatId, senderId, chatType = "p2p") {
	if (chatType === "group") return plain.groupAllowlist.length === 0 || plain.groupAllowlist.includes(chatId);
	return plain.senderAllowlist.length === 0 || plain.senderAllowlist.includes(senderId);
}
function apply(ctx, config = {}) {
	let plain = plainConfig(config);
	let channel = null;
	let runManager = null;
	let unsubMessage = null;
	let unsubEvents = [];
	let generation = 0;
	let transition = Promise.resolve();
	ctx.effect(() => {
		let dead = false;
		const isAlive = () => !dead;
		const boot = async () => {
			const current = ++generation;
			const currentAlive = () => isAlive() && generation === current;
			plain = plainConfig(config);
			const appSecret = await resolveAppSecret(ctx, config);
			if (!currentAlive()) return;
			const chan = createLarkChannel({
				appId: plain.appId,
				appSecret,
				transport: "websocket",
				domain: plain.domain,
				policy: { requireMention: plain.requireMention },
				safety: { chatQueue: { enabled: true } }
			});
			channel = chan;
			try {
				await chan.connect();
			} catch (e) {
				ctx.logger?.error?.("[connect-lark] channel connect failed: " + e.message);
				throw e;
			}
			if (!currentAlive()) {
				try {
					await chan.disconnect();
				} catch {}
				return;
			}
			ctx.logger?.info?.("[connect-lark] channel connected");
			runManager = new RunManager({
				resolveAgent: async (chatId) => {
					const existing = runManager?.getSlot(chatId);
					if (existing?.agent && existing?.sessionId) return {
						agent: existing.agent,
						sessionId: existing.sessionId,
						handle: existing.handle
					};
					if (plain.agentOwnership === "owned-per-chat") {
						const sessionId = "connect-lark:" + chatId;
						const agentOptions = {
							...plain.provider ? { provider: plain.provider } : {},
							...plain.model ? { model: plain.model } : {},
							...plain.reasoningEffort ? { reasoningEffort: plain.reasoningEffort } : {}
						};
						const handle = await ctx.agents.create({
							sessionId,
							meta: { cwd: plain.defaultPath || void 0 },
							...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
						});
						return {
							agent: handle.agent,
							sessionId,
							handle
						};
					}
					if (!plain.attachSessionId) throw new Error("[connect-lark] attach-gui requires attachSessionId");
					const agent = ctx.agents.get(plain.attachSessionId);
					if (!agent) throw new Error("[connect-lark] attachSessionId not found in agent registry");
					return {
						agent,
						sessionId: plain.attachSessionId,
						handle: null
					};
				},
				buildMessage: (content, source) => buildUserMessage(content, source),
				subscribe: (agent, targetSessionId, onDelta, onTurnEnd, onError) => {
					const track = (fn) => {
						unsubEvents.push(fn);
						return fn;
					};
					const unsubStream = track(ctx.on("agent/assistant-stream", (evt) => {
						if (evt.agent !== agent) return;
						const frame = evt.frame;
						if (frame?.type === "chunk" && frame.chunk?.type === "text-delta") onDelta(frame.chunk.text);
					}));
					const unsubTurn = ctx.on("session/event", (session, event) => {
						if (event?.type === "turn/end" && session?.id === targetSessionId) onTurnEnd();
					});
					const unsubError = ctx.on("agent/error", (evt) => {
						if (evt.agent === agent) onError(evt.error);
					});
					unsubEvents.push(unsubStream, unsubTurn, unsubError);
					return () => {
						try {
							unsubStream();
						} catch {}
						try {
							unsubTurn();
						} catch {}
						try {
							unsubError();
						} catch {}
					};
				},
				followup: (agent, message) => {
					agent.followup(message);
				},
				onComplete: (slot) => {
					if (slot.accumulatedText) Promise.resolve(chan.send(slot.chatId, { markdown: slot.accumulatedText })).catch((e) => ctx.logger?.warn?.("[connect-lark] send failed: " + e.message));
				}
			});
			unsubMessage = chan.on("message", async (msg) => {
				if (!currentAlive()) return;
				if (!passesWhitelist(plain, msg.chatId, msg.senderId, msg.chatType)) return;
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (!text) return;
				let content = [{
					type: "text",
					text
				}];
				const images = extractImages(msg);
				if (images.length > 0) {
					const admitResults = [];
					for (const img of images) try {
						const buf = await chan.downloadResource(msg.messageId, img.fileKey, "image");
						let admit;
						if (!plain.provider || !plain.model) admit = {
							supported: true,
							refs: [{ _passthrough: true }],
							reason: "attach-gui passthrough"
						};
						else admit = await admitImage(ctx, plain.provider, plain.model, buf);
						admitResults.push(admit);
					} catch (e) {
						ctx.logger?.warn?.("[connect-lark] image download failed: " + e.message);
					}
					if (admitResults.some((r) => !r.supported)) {
						const reply = IMAGE_UNSUPPORTED_REPLY;
						Promise.resolve(chan.send(msg.chatId, { markdown: reply })).catch((e) => ctx.logger?.warn?.("[connect-lark] send failed: " + e.message));
						return;
					}
					content = buildImageContent(text, {
						supported: true,
						refs: admitResults.flatMap((r) => r.refs)
					});
				}
				try {
					await runManager.start(msg.chatId, content, { kind: "user" });
				} catch (e) {
					ctx.logger?.error?.("[connect-lark] run failed: " + e.message);
					Promise.resolve(chan.send(msg.chatId, { markdown: "[connect-lark] 运行失败：" + e.message })).catch(() => {});
				}
			});
			ctx.logger?.info?.("[connect-lark] ready");
		};
		const cleanup = async () => {
			generation++;
			for (const unsub of unsubEvents) try {
				unsub();
			} catch {}
			unsubEvents = [];
			if (unsubMessage) try {
				unsubMessage();
			} catch {}
			unsubMessage = null;
			const chan = channel;
			channel = null;
			const manager = runManager;
			runManager = null;
			await Promise.allSettled([chan ? Promise.resolve(chan.disconnect()) : Promise.resolve(), manager ? Promise.resolve(manager.disposeAll()) : Promise.resolve()]);
		};
		const queueBoot = () => {
			transition = transition.then(async () => {
				await cleanup();
				if (!dead) await boot();
			}).catch((e) => {
				ctx.logger?.error?.("[connect-lark] boot failed: " + e.message);
			});
		};
		const unsubVolatile = ctx.on("loader/volatile-update", queueBoot);
		queueBoot();
		return async () => {
			dead = true;
			try {
				unsubVolatile();
			} catch {}
			transition = transition.then(cleanup).catch(() => {});
			await transition;
			ctx.logger?.info?.("[connect-lark] disposed");
		};
	});
}
function extractText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("");
	return "";
}
function extractImages(msg) {
	const images = [];
	if (Array.isArray(msg?.resources)) {
		for (const r of msg.resources) if (r?.type === "image" && r?.fileKey) images.push({ fileKey: r.fileKey });
	}
	return images;
}
const CONTRACT_NOTES = {
	createAgent: "ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model } })",
	userMessage: "createUserMessage({ content, source: { kind: \"user\" } }) from @deepseek-ai/dsh-llm",
	drive: "handle.agent.followup(message) — AgentHandle has no followup(); returns void",
	events: "agent/assistant-stream, agent/inbox/claimed, agent/error, session/event turn/start + turn/end",
	visualGate: "await ctx.llm.resolveModelInfo(provider, model, signal); guard undefined inputModalities",
	credentialField: "z.string().role(\"credential-ref\").default(...).volatile(), then credentialRef(...)",
	parsedUnwrap: "plainConfig(parsed) before reading any field — volatile fields are wrapper objects",
	failClosed: "throw on unusable ref name / blank resolved value; never return an empty secret",
	whitelistFailClosed: "empty senderAllowlist + empty groupAllowlist = deny all messages",
	streaming: "channel.stream(to, { markdown: async (c) => { c.append(delta) } }) — SDK-owned CardKit"
};
export { CONTRACT_NOTES, Config, FEISHU_CDN_HOSTS, IMAGE_UNSUPPORTED_REPLY, MAX_IMAGE_BYTES, RunManager, admitImage, apply, buildImageContent, buildUserMessage, downloadInboundImage, inject, passesWhitelist, plainConfig, resolveAppSecret, richCard, streamMarkdown, streamRichCard };
