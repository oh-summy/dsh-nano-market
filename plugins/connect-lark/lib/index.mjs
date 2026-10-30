import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createLarkChannel } from "@larksuite/channel";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	if (opts.buttons && opts.buttons.length > 0) for (const b of opts.buttons) {
		const behaviors = [];
		if (b.url) behaviors.push({
			type: "open_url",
			default_url: b.url
		});
		if (b.value) behaviors.push({
			type: "callback",
			value: { value: b.value }
		});
		elements.push({
			tag: "button",
			text: {
				tag: "plain_text",
				content: b.text
			},
			type: "primary",
			size: "small",
			behaviors
		});
	}
	if (opts.note) elements.push({
		tag: "div",
		text: {
			tag: "plain_text",
			content: opts.note
		}
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
* Internal helper: stream plain markdown via channel.stream().
* Not used by the production reply path (which uses rich cards).
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
/** How often to sweep for TTL-expired slots (independent of new messages). */
const TTL_SWEEP_INTERVAL_MS = 6e4;
const MAX_TEXT_CHARS = 2e5;
const MAX_THINKING_CHARS = 1e5;
function truncateTail(text, limit) {
	return text.length <= limit ? text : text.slice(0, limit) + "\n…(已截断)";
}
/**
* Manages per-chat run slots with ordered execution and cancellation.
*/
var RunManager = class {
	slots = /* @__PURE__ */ new Map();
	opts;
	unsubs = /* @__PURE__ */ new Map();
	watchdogs = /* @__PURE__ */ new Map();
	starting = /* @__PURE__ */ new Set();
	ttlSweep = null;
	disposed = false;
	constructor(opts) {
		this.opts = opts;
		this.ttlSweep = setInterval(() => {
			this.evictOldest(false);
		}, TTL_SWEEP_INTERVAL_MS);
		this.ttlSweep.unref?.();
	}
	/** Get or create a run slot for a chat. */
	getOrCreate(chatId) {
		if (!this.slots.has(chatId)) {
			this.evictOldest(false, chatId);
			if (this.slots.size >= 100) {
				if (![...this.slots.values()].some((s) => s.state === "idle" || s.state === "done")) throw new Error("too many active chats; finish some before starting a new one");
				this.evictOldest(true, chatId);
			}
		}
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
				thinkingText: "",
				turnId: null,
				pending: [],
				lastActiveAt: Date.now()
			};
			this.slots.set(chatId, slot);
		}
		return slot;
	}
	/** Evict the oldest idle/done slot. When force is true (capacity reached)
	* the TTL is ignored so the cap is a hard bound. excludeChatId prevents
	* the just-completed slot from evicting itself. */
	async evictOldest(force = false, excludeChatId) {
		const now = Date.now();
		let oldest;
		for (const slot of this.slots.values()) {
			if (slot.state !== "idle" && slot.state !== "done") continue;
			if (excludeChatId && slot.chatId === excludeChatId) continue;
			if (!force && slot.lastActiveAt > now - 6e5) continue;
			if (!oldest || slot.lastActiveAt < oldest.lastActiveAt) oldest = slot;
		}
		if (oldest) await this.disposeSlot(oldest.chatId);
	}
	/** Get a slot by chatId (for reuse/diagnostics). */
	getSlot(chatId) {
		return this.slots.get(chatId);
	}
	/** Check if a chat has an active run. */
	isRunning(chatId) {
		const slot = this.slots.get(chatId);
		return slot?.state === "running" || slot?.state === "cancelling" || slot?.state === "finishing";
	}
	/**
	* Start a run for a chat (or resume if one is already active).
	* Returns the slot; the actual work happens via subscribe + followup.
	*/
	async start(chatId, content, source, title) {
		if (this.disposed) throw new Error("RunManager is disposed");
		const promise = this.startInternal(chatId, content, source, title);
		this.starting.add(promise);
		try {
			return await promise;
		} finally {
			this.starting.delete(promise);
		}
	}
	async startInternal(chatId, content, source, title) {
		const slot = this.getOrCreate(chatId);
		if (this.isRunning(chatId)) {
			if (slot.pending.length >= 8) throw new Error("queue is full; drop oldest message or wait for the current run");
			slot.pending.push({
				content,
				source
			});
			return slot;
		}
		slot.lastActiveAt = Date.now();
		slot.state = "running";
		try {
			const { agent, sessionId, handle } = await this.opts.resolveAgent(chatId, title);
			if (this.disposed) {
				if (handle) await handle.dispose();
				throw new Error("RunManager is disposed");
			}
			if ([...this.slots.values()].some((other) => other !== slot && other.sessionId === sessionId && (other.state === "running" || other.state === "cancelling"))) {
				if (handle) await handle.dispose();
				throw new Error("Session is already running in another chat");
			}
			slot.agent = agent;
			slot.handle = handle;
			slot.sessionId = sessionId;
			slot.failedWith = void 0;
			slot.streamController = void 0;
			slot.streamDone = void 0;
			slot.streamPromise = void 0;
			slot.streamFailed = void 0;
			slot.streamReady = void 0;
			slot.streamReadyResolve = void 0;
			const unsub = this.opts.subscribe(agent, sessionId, (delta, kind) => {
				if (kind === "reasoning") {
					slot.thinkingText = truncateTail(slot.thinkingText + delta, MAX_THINKING_CHARS);
					this.opts.onThinking?.(slot, delta);
				} else {
					slot.accumulatedText = truncateTail(slot.accumulatedText + delta, MAX_TEXT_CHARS);
					this.opts.onDelta?.(slot, delta);
				}
			}, () => {
				this.complete(chatId);
			}, (e) => {
				this.fail(chatId, e);
			});
			this.unsubs.set(chatId, unsub);
			slot.cancelController = new AbortController();
			slot.accumulatedText = "";
			slot.thinkingText = "";
			slot.turnId = (slot.turnId ?? 0) + 1;
			await this.opts.onStart?.(slot);
			if (this.disposed) {
				this.cleanup(chatId);
				throw new Error("RunManager is disposed");
			}
			this.opts.followup(agent, this.opts.buildMessage(content, source));
			return slot;
		} catch (error) {
			this.cleanup(chatId);
			slot.state = "idle";
			slot.streamDone?.();
			throw error;
		}
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
		try {
			Promise.resolve(this.opts.onCancel?.(slot)).catch(() => {});
		} catch {}
		const watchdog = setTimeout(() => {
			this.watchdogs.delete(chatId);
			const s = this.slots.get(chatId);
			if (s && s.state === "cancelling") this.complete(chatId);
		}, 3e4);
		watchdog.unref?.();
		this.watchdogs.set(chatId, watchdog);
	}
	/** Mark a run as complete and process the next queued message. */
	async complete(chatId) {
		const slot = this.slots.get(chatId);
		if (!slot || slot.state !== "running" && slot.state !== "cancelling") return;
		slot.state = "finishing";
		this.cleanup(chatId);
		try {
			await this.opts.onComplete?.(slot);
		} catch {}
		slot.state = "done";
		await this.evictOldest(false, chatId);
		slot.streamController = void 0;
		slot.streamPromise = void 0;
		slot.streamFailed = void 0;
		slot.streamReady = void 0;
		slot.streamReadyResolve = void 0;
		if (slot.pending.length > 0 && !this.disposed) {
			const next = slot.pending.shift();
			try {
				await this.start(chatId, next.content, next.source);
			} catch (error) {
				await this.fail(chatId, error);
			}
		}
	}
	/** Mark a run as failed and reset state. */
	async fail(chatId, error) {
		const slot = this.slots.get(chatId);
		if (!slot || slot.state === "done" || slot.state === "finishing") return;
		slot.state = "finishing";
		slot.failedWith = error;
		this.cleanup(chatId);
		try {
			await this.opts.onComplete?.(slot);
		} catch {}
		slot.state = "done";
		await this.evictOldest(false, chatId);
		slot.streamController = void 0;
		slot.streamPromise = void 0;
		slot.streamFailed = void 0;
		slot.streamReady = void 0;
		slot.streamReadyResolve = void 0;
		if (slot.pending.length > 0 && !this.disposed) {
			const next = slot.pending.shift();
			try {
				await this.start(chatId, next.content, next.source);
			} catch (nextError) {
				await this.fail(chatId, nextError);
			}
		}
	}
	/** Dispose a single slot: unsubscribe, dispose handle, drop it. */
	async disposeSlot(chatId) {
		const slot = this.slots.get(chatId);
		if (!slot) return;
		this.cleanup(chatId);
		if (slot.handle) await Promise.resolve(slot.handle.dispose()).catch(() => {});
		this.slots.delete(chatId);
	}
	/** Wait for in-flight runs to settle before teardown.
	* Used by config-save cleanup so a turn is not cancelled mid-reply.
	* Returns early if the deadline passes; callers then dispose what remains.
	*/
	async drain(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while ([...this.slots.values()].some((s) => s.state === "running" || s.state === "cancelling" || s.state === "finishing")) {
			if (Date.now() >= deadline) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	/** Dispose all owned agents and clear all slots. */
	cleanup(chatId) {
		const unsub = this.unsubs.get(chatId);
		if (unsub) try {
			unsub();
		} catch {}
		this.unsubs.delete(chatId);
		const watchdog = this.watchdogs.get(chatId);
		if (watchdog) clearTimeout(watchdog);
		this.watchdogs.delete(chatId);
	}
	async disposeAll() {
		this.disposed = true;
		if (this.ttlSweep) {
			clearInterval(this.ttlSweep);
			this.ttlSweep = null;
		}
		const failures = [];
		for (const slot of this.slots.values()) try {
			slot.streamReadyResolve?.();
		} catch {}
		for (const slot of this.slots.values()) {
			try {
				slot.cancelController?.abort();
			} catch {}
			try {
				slot.streamDone?.();
			} catch {}
			if (slot.state === "running" || slot.state === "cancelling") try {
				await this.opts.onCancel?.(slot);
			} catch {}
		}
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
// src/users.ts
/** 飞书该接口的 page_size 上限是 50，超过就 400。 */
const PAGE_SIZE = 50;
/** 最多翻几页：通讯录很大时不至于把整本拉下来。 */
const MAX_PAGES = 4;
/**
* 拉取可授权用户列表。
*
* @param token - 飞书 tenant_access_token
* @param fetchImpl - 注入的 fetch，便于测试
* @param timeoutMs - 单次请求超时
* @returns 用户列表与管理员；失败时 ok=false 且带原因
*/
async function listDirectoryUsers(token, fetchImpl = fetch, timeoutMs = 8e3) {
	const url = "https://open.feishu.cn/open-apis/contact/v3/users/find_by_department?user_id_type=open_id&department_id=0&page_size=" + String(PAGE_SIZE);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { Authorization: "Bearer " + token }
		});
		const body = await response.text();
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			parsed = void 0;
		}
		if (!response.ok || !parsed || parsed.code !== 0) return {
			ok: false,
			users: [],
			reason: parsed?.msg || "HTTP " + String(response.status)
		};
		const users = [];
		for (const item of parsed?.data?.items ?? []) {
			if (!item?.open_id) continue;
			users.push({
				name: String(item.name ?? item.en_name ?? item.open_id),
				openId: String(item.open_id),
				isManager: item.is_tenant_manager === true,
				...item.email ? { email: String(item.email) } : {}
			});
		}
		const manager = users.find((user) => user.isManager);
		return {
			ok: true,
			users,
			...manager ? { manager } : {}
		};
	} catch (error) {
		return {
			ok: false,
			users: [],
			reason: error?.message || "directory request failed"
		};
	}
}
/**
* 通过飞书 SDK 拉取可授权用户（SDK 自带 token 缓存，调用方无需持密钥）。
*
* @param client - 飞书 SDK 客户端（通常是 channel.rawClient）
* @returns 用户列表与租户管理员；失败时 ok=false 且带原因
*/
async function fetchDirectoryUsers(client) {
	const users = [];
	let manager;
	let lastReason = "directory unavailable";
	try {
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = await client.contact.v3.user.findByDepartment({ params: {
				user_id_type: "open_id",
				department_id: "0",
				page_size: PAGE_SIZE
			} });
			if (response?.code !== 0) {
				lastReason = response?.msg || lastReason;
				break;
			}
			const items = response?.data?.items ?? [];
			for (const item of items) {
				if (!item?.open_id) continue;
				const user = {
					name: String(item.name ?? item.en_name ?? item.open_id),
					openId: String(item.open_id),
					isManager: item.is_tenant_manager === true,
					...item.email ? { email: String(item.email) } : {}
				};
				users.push(user);
				if (user.isManager && !manager) manager = user;
			}
			if (!response?.data?.has_more) break;
		}
		if (users.length === 0 && !manager) return {
			ok: false,
			users: [],
			reason: lastReason
		};
		return {
			ok: true,
			users,
			...manager ? { manager } : {}
		};
	} catch (error) {
		return {
			ok: false,
			users: [],
			reason: error?.message || "directory request failed"
		};
	}
}
// src/directory-service.ts
/** 本机端口。dsh-remote 占用 9091，这里错开。 */
const DIRECTORY_PORT = 9092;
/** 允许本地开发页与本机 DSH 页面跨域读取。 */
const DEFAULT_ORIGINS = [
	"null",
	"http://127.0.0.1:3080",
	"http://localhost:3080",
	"http://127.0.0.1:8080",
	"http://localhost:8080"
];
/**
* 起一个只读的本机 HTTP 面，给配置页提供「可授权用户」列表。
*
* @param options - 目录来源与跨域白名单
* @returns 已监听的目录服务
*/
async function startDirectoryService(options) {
	new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
	const port = options.port ?? 9092;
	const server = createServer((req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Vary", "Origin");
		if (req.method === "OPTIONS") {
			res.setHeader("Access-Control-Allow-Methods", "GET");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			res.writeHead(204);
			res.end();
			return;
		}
		if (req.method !== "GET" || !req.url?.startsWith("/lark-api/users")) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				ok: false,
				users: [],
				reason: "not found"
			}));
			return;
		}
		options.listUsers().then((result) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(result));
		}).catch((error) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				ok: false,
				users: [],
				reason: error?.message || "directory failed"
			}));
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	return {
		port: typeof address === "object" && address !== null ? address.port : port,
		close: () => new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		})
	};
}
// src/images.ts
/** Maximum image bytes to admit (20 MiB default, same as dsh-acp). */
const MAX_IMAGE_BYTES = 20971520;
/** Download an inbound image with bounded heap usage. */
async function downloadImageBounded(channel, messageId, fileKey) {
	if (channel.rawClient) try {
		const response = await channel.rawClient.im.v1.messageResource.get({
			path: {
				message_id: messageId,
				file_key: fileKey
			},
			params: { type: "image" },
			responseType: "stream"
		});
		const contentLength = response.headers?.["content-length"];
		if (contentLength) {
			const size = parseInt(contentLength, 10);
			if (!Number.isNaN(size) && size > 20971520) {
				response.data?.destroy?.();
				throw new Error("image exceeds 20971520 bytes");
			}
		}
		response.data?.destroy?.();
	} catch (e) {
		if (/exceeds/.test(e.message)) throw e;
	}
	if (channel.downloadResourceToFile) {
		const dir = await mkdtemp(join(tmpdir(), "connect-lark-"));
		const destPath = join(dir, "image.bin");
		try {
			await channel.downloadResourceToFile(messageId, fileKey, "image", destPath);
			if ((await stat(destPath)).size > 20971520) throw new Error("image exceeds 20971520 bytes");
			return await readFile(destPath);
		} finally {
			await rm(dir, {
				recursive: true,
				force: true
			});
		}
	}
	const buffer = await channel.downloadResource(messageId, fileKey, "image");
	if (buffer.byteLength > 20971520) throw new Error("image exceeds 20971520 bytes");
	return buffer;
}
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
	if (buffer.byteLength > 20971520) return {
		supported: false,
		refs: [],
		reason: "image exceeds 20971520 bytes"
	};
	if (provider && model) {
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
	}
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
* Internal helper: inbound image download (SSRF-guarded).
* Not used by the production path (which uses downloadImageBounded).
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
	"credentials",
	"sessionController",
	"permissionPresets",
	"workspaceRegistry"
];
const Config = z.object({
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
	accessMode: z.union([
		"app",
		"list",
		"open",
		"restricted"
	]).default("app").volatile().comment("访问模式：app=跟随飞书应用的可用范围（默认，插件不额外限制）；list=只允许授权名单与租户管理员"),
	senderAllowlist: z.array(z.string()).default([]).volatile().comment("私聊用户限制；restricted 模式下为空则拒绝所有私聊"),
	groupAllowlist: z.array(z.string()).default([]).volatile().comment("群聊限制；restricted 模式下为空则拒绝所有群聊"),
	thinkingPolicy: z.union([
		"cot-visible",
		"cot-discard",
		"stream-only"
	]).default("cot-visible").volatile().comment("思考展示：cot-visible=在卡片中显示思考过程；cot-discard/stream-only=不显示"),
	reasoningEffort: z.string().default("").volatile().comment("思考强度；留空跟随 DSH 当前模型默认配置"),
	permissionPreset: z.string().default("").volatile().comment("权限模式；留空跟随 DSH 默认，支持 read-only/workspace-write/danger-full-access/auto")
});
/** Bound a promise; resolve false when the timer fires instead of hanging. */
function withTimeout(promise, ms) {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, ms);
		timer.unref?.();
		Promise.resolve(promise).then(() => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(true);
			}
		}, () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(false);
			}
		});
	});
}
/** How long to wait for the card producer to start before treating it as failed.
*  Read at call time (not module load) so tests can override it per-run. */
function streamReadyTimeoutMs() {
	return Number(process.env.CONNECT_LARK_STREAM_TIMEOUT_MS) || 1e4;
}
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
function passesWhitelist(plain, chatId, senderId, chatType = "p2p", managerOpenId = "") {
	if (plain.accessMode === "app" || plain.accessMode === "open") return true;
	if (chatType === "group") return plain.groupAllowlist.includes(chatId);
	if (plain.senderAllowlist.includes(senderId)) return true;
	if (plain.openId && plain.openId === senderId) return true;
	return Boolean(managerOpenId) && managerOpenId === senderId;
}
/** Resolve model and effort from explicit overrides or the DSH new-session default. */
function resolveAgentModelOptions(plain, catalog) {
	const hasOverride = Boolean(plain.provider && plain.model);
	const provider = hasOverride ? plain.provider : catalog.default.provider;
	const model = hasOverride ? plain.model : catalog.default.model;
	let reasoningEffort = plain.reasoningEffort;
	if (!reasoningEffort) {
		if (hasOverride) reasoningEffort = ((catalog.groups ?? []).find((item) => item.id === provider)?.models?.find((item) => item.id === model))?.reasoning?.defaultEffort ?? "";
		else reasoningEffort = catalog.default.reasoningEffort ?? "";
	}
	return {
		provider,
		model,
		...reasoningEffort ? { reasoningEffort } : {}
	};
}
/** Create a per-chat agent, reusing live agents and resuming persisted sessions. */
async function createOrResumeAgent(ctx, sessionId, meta, agentOptions, permissionPreset = "") {
	const applyPreset = (agent) => {
		if (permissionPreset) ctx.permissionPresets.set(agent.session, permissionPreset);
	};
	if (ctx.sessionController?.resolveAgent) try {
		const resolved = await ctx.sessionController.resolveAgent(sessionId);
		if (resolved?.agent) {
			applyPreset(resolved.agent);
			return {
				agent: resolved.agent,
				sessionId,
				handle: null
			};
		}
	} catch (error) {
		if (!/writer-held|active write handle/i.test(error.message)) throw error;
	}
	for (let attempt = 0; attempt < 4; attempt++) {
		const live = ctx.agents.get(sessionId);
		if (live) {
			applyPreset(live);
			return {
				agent: live,
				sessionId,
				handle: null
			};
		}
		try {
			const handle = await ctx.agents.create({
				sessionId,
				meta,
				agentOptions
			});
			applyPreset(handle.agent);
			return {
				agent: handle.agent,
				sessionId,
				handle
			};
		} catch (error) {
			if (!/already exists|already registered|active write handle/i.test(error.message)) throw error;
			if (attempt < 3) {
				await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
				continue;
			}
			try {
				const handle = await ctx.agents.resume({
					resumeSessionId: sessionId,
					agentOptions
				});
				applyPreset(handle.agent);
				return {
					agent: handle.agent,
					sessionId,
					handle
				};
			} catch (resumeError) {
				if (!/active write handle|writer-held/i.test(resumeError.message)) throw resumeError;
				const fallbackSessionId = sessionId + ":" + Date.now();
				const handle = await ctx.agents.create({
					sessionId: fallbackSessionId,
					meta,
					agentOptions
				});
				applyPreset(handle.agent);
				return {
					agent: handle.agent,
					sessionId: fallbackSessionId,
					handle
				};
			}
		}
	}
	throw new Error("unreachable");
}
/** Update one streaming rich card with the latest answer and optional CoT. */
async function updateRunCard(slot, thinkingPolicy) {
	if (!slot.streamController) return;
	const lines = [];
	if (slot.failedWith) lines.push("**运行失败：** " + slot.failedWith.message);
	else if (slot.accumulatedText) lines.push(slot.accumulatedText);
	else if (slot.state === "done" || slot.state === "finishing") lines.push("本次回复没有文本输出。");
	else lines.push("正在生成回复…");
	if (thinkingPolicy === "cot-visible" && slot.thinkingText) {
		lines.push("---", "**思考过程**");
		lines.push(slot.thinkingText.split("\n").map((line) => "> " + line).join("\n"));
	}
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	await slot.streamController.update(richCard({
		title: "DSH 回复",
		color: "blue",
		lines,
		note: "connect-lark · by @oh-summy · " + timestamp,
		buttons: [{
			text: "dsh-nano-market",
			url: "https://github.com/oh-summy/dsh-nano-market"
		}]
	}));
}
function apply(ctx, config = {}) {
	let plain = plainConfig(config);
	let channel = null;
	let runManager = null;
	let unsubMessage = null;
	let directoryService = null;
	let managerOpenId = "";
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
				httpTimeoutMs: 3e4,
				domain: plain.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
				policy: { requireMention: plain.requireMention },
				safety: { chatQueue: { enabled: true } }
			});
			channel = chan;
			try {
				await chan.connect();
			} catch (e) {
				ctx.logger?.error?.("[connect-lark] channel connect failed: " + e.message);
				try {
					await chan.disconnect();
				} catch {}
				throw e;
			}
			if (!currentAlive()) {
				try {
					await chan.disconnect();
				} catch {}
				return;
			}
			ctx.logger?.info?.("[connect-lark] channel connected");
			try {
				const directory = await fetchDirectoryUsers(chan.rawClient);
				if (directory.ok && directory.manager) {
					managerOpenId = directory.manager.openId;
					ctx.logger?.info?.("[connect-lark] tenant manager detected");
				}
			} catch (e) {
				ctx.logger?.warn?.("[connect-lark] manager lookup failed: " + e.message);
			}
			try {
				directoryService = await startDirectoryService({ listUsers: () => fetchDirectoryUsers(chan.rawClient) });
				ctx.logger?.info?.("[connect-lark] user directory on 127.0.0.1:" + directoryService.port);
			} catch (e) {
				ctx.logger?.warn?.("[connect-lark] user directory unavailable: " + e.message);
			}
			if (!currentAlive()) {
				try {
					await directoryService?.close();
				} catch {}
				return;
			}
			runManager = new RunManager({
				resolveAgent: async (chatId, title) => {
					const existing = runManager?.getSlot(chatId);
					const present = async (sessionId) => {
						if (existing?.titleSet || plain.agentOwnership !== "owned-per-chat") return;
						try {
							const cwd = plain.defaultPath || process.cwd();
							const workspace = ctx.workspaceRegistry.list().find((item) => item.path === cwd);
							if (workspace) await workspace.attachSession(sessionId);
							if (title) await ctx.sessionController.rename({
								sessionId,
								title
							});
							if (existing) existing.titleSet = true;
						} catch (error) {
							ctx.logger?.warn?.("[connect-lark] session presentation failed: " + error.message);
						}
					};
					if (existing?.agent && existing?.sessionId) {
						await present(existing.sessionId);
						return {
							agent: existing.agent,
							sessionId: existing.sessionId,
							handle: existing.handle
						};
					}
					if (plain.agentOwnership === "owned-per-chat") {
						const sessionId = "connect-lark:" + chatId;
						const catalog = await ctx.sessionController.modelCatalog();
						const agentOptions = resolveAgentModelOptions(plain, catalog);
						const { agent, sessionId: resolvedSessionId, handle } = await createOrResumeAgent(ctx, sessionId, { cwd: plain.defaultPath || void 0 }, agentOptions, plain.permissionPreset);
						await present(resolvedSessionId);
						return {
							agent,
							sessionId: resolvedSessionId,
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
						return () => {
							try {
								fn();
							} finally {
								unsubEvents = unsubEvents.filter((item) => item !== fn);
							}
						};
					};
					const unsubStream = track(ctx.on("agent/assistant-stream", (evt) => {
						if (evt.agent !== agent) return;
						const frame = evt.frame;
						if (frame?.type === "chunk" && frame.chunk?.type === "text-delta") onDelta(frame.chunk.text, "text");
						else if (frame?.type === "chunk" && frame.chunk?.type === "reasoning-delta") onDelta(frame.chunk.text, "reasoning");
					}));
					const unsubTurn = ctx.on("session/event", (session, event) => {
						if (event?.type === "turn/end" && session?.id === targetSessionId) onTurnEnd();
					});
					const unsubError = ctx.on("agent/error", (evt) => {
						if (evt.agent === agent) onError(evt.error);
					});
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
				onCancel: (slot) => {
					if (plain.agentOwnership !== "owned-per-chat") return;
					return ctx.sessionController.cancel({ sessionId: slot.sessionId });
				},
				onStart: (slot) => {
					const done = new Promise((resolve) => {
						slot.streamDone = resolve;
					});
					slot.streamReady = new Promise((resolve) => {
						slot.streamReadyResolve = resolve;
					});
					const thisTurn = slot.turnId;
					slot.streamPromise = chan.stream(slot.chatId, { card: {
						initial: richCard({
							title: "DSH 回复",
							color: "blue",
							lines: ["正在连接 DSH Agent…"],
							note: "connect-lark · by @oh-summy · " + (/* @__PURE__ */ new Date()).toISOString(),
							buttons: [{
								text: "dsh-nano-market",
								url: "https://github.com/oh-summy/dsh-nano-market"
							}]
						}),
						producer: async (controller) => {
							if (slot.turnId !== thisTurn) return;
							slot.streamController = controller;
							slot.streamReadyResolve?.();
							await done;
						}
					} });
					Promise.resolve(slot.streamPromise).catch((e) => {
						if (slot.turnId === thisTurn) {
							slot.streamFailed = e;
							slot.streamReadyResolve?.();
						}
						ctx.logger?.warn?.("[connect-lark] stream failed: " + e.message);
					});
				},
				onDelta: (slot) => {
					updateRunCard(slot, plain.thinkingPolicy).catch((e) => ctx.logger?.warn?.("[connect-lark] card update failed: " + e.message));
				},
				onThinking: (slot) => {
					updateRunCard(slot, plain.thinkingPolicy).catch((e) => ctx.logger?.warn?.("[connect-lark] card update failed: " + e.message));
				},
				onComplete: async (slot) => {
					try {
						if (!slot.streamController && !slot.streamFailed) {
							if (!await withTimeout(slot.streamReady ?? Promise.resolve(), streamReadyTimeoutMs())) slot.streamFailed = /* @__PURE__ */ new Error("stream producer did not start within " + streamReadyTimeoutMs() + "ms");
						}
						if (slot.streamFailed || !slot.streamController) {
							const reply = slot.accumulatedText || (slot.failedWith ? "[connect-lark] 运行失败：" + slot.failedWith.message : "[connect-lark] 回复未生成");
							await chan.send(slot.chatId, { markdown: reply });
							return;
						}
						try {
							await updateRunCard(slot, plain.thinkingPolicy);
						} catch (e) {
							const reply = slot.accumulatedText || (slot.failedWith ? "[connect-lark] 运行失败：" + slot.failedWith.message : "[connect-lark] 回复未生成");
							await chan.send(slot.chatId, { markdown: reply });
						}
					} finally {
						slot.streamDone?.();
					}
				}
			});
			unsubMessage = chan.on("message", async (msg) => {
				if (!currentAlive()) return;
				if (!passesWhitelist(plain, msg.chatId, msg.senderId, msg.chatType, managerOpenId)) return;
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (!text) return;
				let content = [{
					type: "text",
					text
				}];
				const images = extractImages(msg);
				if (images.length > 0) {
					let gateProvider = plain.provider;
					let gateModel = plain.model;
					let modelCatalogFailed = false;
					if (plain.agentOwnership === "owned-per-chat" && (!gateProvider || !gateModel)) try {
						const cat = await ctx.sessionController.modelCatalog();
						const route = resolveAgentModelOptions(plain, cat);
						gateProvider = route.provider;
						gateModel = route.model;
					} catch (e) {
						modelCatalogFailed = true;
						ctx.logger?.warn?.("[connect-lark] cannot resolve default model for image gate: " + e.message);
					}
					const admitResults = [];
					if (modelCatalogFailed) admitResults.push({
						supported: false,
						refs: [],
						reason: "cannot resolve the default model to verify image input"
					});
					const limited = images.slice(0, 4);
					if (images.length > 4) admitResults.push({
						supported: false,
						refs: [],
						reason: "too many images in one message"
					});
					for (const img of limited) try {
						const buf = await downloadImageBounded(chan, msg.messageId, img.fileKey);
						const admit = await admitImage(ctx, gateProvider, gateModel, buf);
						admitResults.push(admit);
					} catch (e) {
						admitResults.push({
							supported: false,
							refs: [],
							reason: e.message
						});
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
					const title = text.trim().replace(/\s+/g, " ").slice(0, 32) || "飞书消息";
					await runManager.start(msg.chatId, content, { kind: "user" }, title);
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
			await Promise.resolve(manager?.drain(3e3)).catch(() => {});
			const directory = directoryService;
			directoryService = null;
			await Promise.allSettled([
				chan ? Promise.resolve(chan.disconnect()) : Promise.resolve(),
				manager ? Promise.resolve(manager.disposeAll()) : Promise.resolve(),
				directory ? Promise.resolve(directory.close()) : Promise.resolve()
			]);
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
	whitelistFailClosed: "accessMode=app (default) defers to the Feishu app scope; accessMode=list allows only the grants plus the tenant manager",
	streaming: "channel.stream(to, { markdown: async (c) => { c.append(delta) } }) — SDK-owned CardKit"
};
export { CONTRACT_NOTES, Config, DIRECTORY_PORT, FEISHU_CDN_HOSTS, IMAGE_UNSUPPORTED_REPLY, MAX_IMAGE_BYTES, RunManager, admitImage, apply, buildImageContent, buildUserMessage, createOrResumeAgent, downloadImageBounded, downloadInboundImage, fetchDirectoryUsers, inject, listDirectoryUsers, passesWhitelist, plainConfig, resolveAgentModelOptions, resolveAppSecret, richCard, startDirectoryService, streamMarkdown };
