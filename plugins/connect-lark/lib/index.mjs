import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import os, { homedir, tmpdir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createLarkChannel } from "@larksuite/channel";
import { createServer } from "node:http";
// src/cards.ts
/**
* CardKit 2.0 折叠面板：默认收起，点标题展开。用于「思考过程」——
* 只保留实测被飞书接受的属性（2.0 拒绝 border.style/background_style 等 1.0 字段）。
*/
function collapsiblePanel(panel) {
	return {
		tag: "collapsible_panel",
		expanded: panel.expanded === true,
		header: {
			title: {
				tag: "plain_text",
				content: panel.title
			},
			vertical_align: "center",
			icon: {
				tag: "standard_icon",
				token: "down-small_outlined"
			},
			icon_position: "follow"
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: panel.content
			}
		}]
	};
}
/**
* Build a CardKit JSON 2.0 object with header + body elements.
*
* This is the "raw CardKit JSON" path — the SDK does NOT own this structure.
* The caller must provide it (ARCHITECTURE §3.2).
*/
function richCard(opts) {
	const elements = [];
	if (opts.status) elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: opts.status
		}
	});
	if (opts.panels) for (const p of opts.panels) elements.push(collapsiblePanel(p));
	for (const line of opts.lines) if (line === "---") elements.push({ tag: "hr" });
	else elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: line
		}
	});
	if (opts.appendElements) for (const el of opts.appendElements) elements.push(el);
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
	const header = {
		title: {
			tag: "plain_text",
			content: opts.title
		},
		template: opts.color
	};
	if (opts.headerSubtitle) header.subtitle = {
		tag: "plain_text",
		content: opts.headerSubtitle
	};
	return {
		schema: "2.0",
		header,
		body: { elements }
	};
}
/**
* Internal helper: stream plain markdown via channel.stream().
* Not used by the production reply path (which uses rich cards).
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
/** One markdown line appended to the finished reply card. */
function settingsStatusLine(display, attachGui) {
	if (attachGui) return "⚙️ 设置：attach-gui 模式共享 GUI 会话，不可用";
	if (!display) return "⚙️ 模型 / 强度 / 权限 / 工作区：跟随 DSH 默认";
	const parts = [];
	if (display.workspace) parts.push("工作区 " + display.workspace);
	if (display.model) parts.push("模型 " + display.model);
	if (display.effort) parts.push("强度 " + display.effort);
	if (display.permission) parts.push("权限 " + display.permission);
	return parts.length > 0 ? "⚙️ " + parts.join(" · ") : "⚙️ 跟随 DSH 默认";
}
/** CardAction callback value of the "关闭" button on the settings card. */
const CANCEL_SETTINGS_VALUE = "cancel-settings";
/** Sentinel option value: clear that dimension back to "follow DSH default". */
const DEFAULT_OPTION_VALUE = "__default__";
/** 「对话」下拉的哨兵值：开启新对话（解除会话绑定，下一条消息起是新会话）。 */
const NEW_CONVERSATION_VALUE = "__new_conversation__";
/** Flat options for the model select: value = "provider:model". */
function modelOptions(catalog) {
	const out = [];
	for (const group of catalog?.groups ?? []) for (const model of group.models ?? []) {
		const providerLabel = group.name || group.id;
		const modelLabel = model.name || model.id;
		out.push({
			label: providerLabel + " · " + modelLabel,
			value: group.id + ":" + model.id
		});
	}
	return out;
}
/** Current model route as a select value ("provider:model") or undefined. */
function currentModelValue(current, catalog) {
	if (current?.provider && current?.model) return current.provider + ":" + current.model;
	const def = catalog?.default;
	if (def?.provider && def?.model) return def.provider + ":" + def.model;
}
/** Effort options for the model the user has (explicit override or default). */
function effortOptions(currentModelValue, catalog) {
	const options = [{
		label: "跟随模型默认",
		value: DEFAULT_OPTION_VALUE
	}];
	if (!currentModelValue) return options;
	const sep = currentModelValue.indexOf(":");
	const provider = currentModelValue.slice(0, sep);
	const modelId = currentModelValue.slice(sep + 1);
	const model = (catalog?.groups ?? []).find((g) => g.id === provider)?.models?.find((m) => m.id === modelId);
	for (const effort of model?.reasoning?.efforts ?? []) options.push({
		label: effort.name,
		value: effort.id
	});
	return options;
}
/** The four select_static elements shared by the combined settings card and
*  the inline settings panel: workspace / model / effort / permission, with
*  empty-option placeholders so Feishu never rejects the card. */
function settingsSelectElements(opts) {
	const elements = [];
	const workspaceOptions = [{
		label: opts.defaultWorkspaceTitle ?? "默认工作区",
		value: DEFAULT_OPTION_VALUE
	}];
	for (const w of opts.workspaces) workspaceOptions.push({
		label: w.title,
		value: w.id
	});
	elements.push(selectStatic("workspace", "工作区", workspaceOptions, opts.current?.workspaceId));
	const modelOptionsList = [{
		label: "跟随 DSH 默认",
		value: DEFAULT_OPTION_VALUE
	}, ...modelOptions(opts.catalog)];
	if (modelOptionsList.length === 1) modelOptionsList.push({
		label: "暂无可用模型",
		value: ""
	});
	elements.push(selectStatic("model", "模型", modelOptionsList, currentModelValue(opts.current, opts.catalog)));
	const effortList = opts.effortList ?? effortOptions(currentModelValue(opts.current, opts.catalog), opts.catalog);
	elements.push(selectStatic("effort", "思考强度", effortList, opts.current?.reasoningEffort));
	const permissionOptions = [];
	for (const p of opts.permissions) permissionOptions.push({
		label: p.name,
		value: p.value
	});
	if (opts.defaultPermission) permissionOptions.push({
		label: "设为 DSH 默认预设",
		value: DEFAULT_OPTION_VALUE
	});
	if (permissionOptions.length === 0) permissionOptions.push({
		label: "跟随 DSH 默认",
		value: DEFAULT_OPTION_VALUE
	});
	elements.push(selectStatic("permission", "权限", permissionOptions, opts.current?.permission));
	return elements;
}
/** Build the inline settings panel embedded at the bottom of every finished
*  reply card：默认折叠的 CardKit 2.0 折叠面板，内嵌四个 select_static ——
*  选择即生效（写该 chat 会话投影 + per-chat 状态），不弹任何单独卡片。
*  折叠面板官方嵌套规则仅禁止 form 容器；内嵌 select_static 需真机验证（S0）。 */
/** 两列分组布局（负责人 2026-11-14 要求：模型+思考强度一组、工作区+权限一组）：
*  每组一个 column_set（左列 label+select，右列 label+select）。
*  label 用粗体（保守样式：text_tag/font 在真机 2.0 渲染不稳，2026-11-18 实测回退）。 */
/** 一行 = 标签与下拉**同排**（负责人 2026-11-18：标题和按钮放一行）。
*  标签列**固定像素宽**（三行统一 48px，标签全部两字），组内贴合 + 跨行对齐
*  （真机反馈：72px 时两字标签右侧空隙过大、思考强度四字又挤压——统一两字「强度」）。
*  固定宽需 flex_mode "none"（2.0 文档：width 具体数值仅 flex_mode none 生效）。 */
function settingsRow(items) {
	return {
		tag: "column_set",
		flex_mode: "none",
		columns: items.map((it) => [{
			tag: "column",
			width: "46px",
			horizontal_align: "center",
			vertical_align: "center",
			elements: [{
				tag: "markdown",
				content: "<text_tag color='" + it.color + "'>" + it.label + "</text_tag>"
			}]
		}, {
			tag: "column",
			width: "weighted",
			weight: 1,
			vertical_align: "center",
			horizontal_spacing: "small",
			elements: [it.select]
		}]).flat()
	};
}
/** 系统提醒卡（轻量）：换对话/新建对话的记录条目——不同维度不同头部色，
*  与正常回复卡（绿）区分（负责人 2026-11-18：系统提醒卡片头部颜色应不一样）。 */
function buildSwitchRecordCard(headerTitle, template, markdownLines, opts) {
	const elements = markdownLines.map((line) => ({
		tag: "markdown",
		content: line
	}));
	if (opts?.conversationSelect) elements.push({
		tag: "select_static",
		name: "conversation",
		placeholder: {
			tag: "plain_text",
			content: "切换对话"
		},
		options: opts.conversationSelect.options.map((o) => ({
			text: {
				tag: "plain_text",
				content: o.label
			},
			value: o.value
		})),
		behaviors: [{
			type: "callback",
			value: { value: "conversation" }
		}],
		...opts.conversationSelect.initial ? { initial_option: opts.conversationSelect.initial } : {}
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: headerTitle
			},
			template
		},
		body: { elements }
	};
}
/** 工作区切换卡：横幅 + 新工作区的「对话」下拉——切换后直接在这条消息里
*  选历史会话接回（负责人 2026-11-18：每个工作区与会话完全绑定）。 */
function buildWorkspaceSwitchCard(fromTitle, toTitle, sessions) {
	const options = [{
		label: "✨ 使用新对话（默认）",
		value: NEW_CONVERSATION_VALUE
	}];
	for (const s of sessions.slice(0, 12)) {
		const name = s.title || s.sessionId.replace(/^session-/, "").slice(0, 8) + "…";
		const rel = relativeTime(s.updatedAt ?? 0);
		options.push({
			label: name + " · " + rel,
			value: s.sessionId
		});
	}
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "📢 已切换工作区"
			},
			template: "turquoise"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: "从 **" + fromTitle + "** 切换至 **" + toTitle + "** · 已开启新对话（不继承历史）"
			},
			{
				tag: "markdown",
				content: "<font color='grey'>如需继续之前的对话，直接在下拉选择（历史与设置保留）：</font>"
			},
			{
				tag: "select_static",
				name: "conversation",
				placeholder: {
					tag: "plain_text",
					content: "切换对话"
				},
				options: options.map((o) => ({
					text: {
						tag: "plain_text",
						content: o.label
					},
					value: o.value
				})),
				behaviors: [{
					type: "callback",
					value: { value: "conversation" }
				}]
			}
		] }
	};
}
/** 相对时间（跟 DSH 会话列表同口径）：10 分钟 / 10 小时 / 3 天 / 2 个月 / 1 年。 */
function relativeTime(updatedAt, now = Date.now()) {
	const diff = Math.max(0, now - updatedAt);
	const minutes = Math.floor(diff / 6e4);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return minutes + " 分钟前";
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return hours + " 小时前";
	const days = Math.floor(hours / 24);
	if (days < 30) return days + " 天前";
	const months = Math.floor(days / 30);
	if (months < 12) return months + " 个月前";
	return Math.floor(months / 12) + " 年前";
}
/** 会话 select：新对话 + 本工作区**全部**会话——有标题显标题，无标题显 id + 相对时间
*  （跟 DSH 会话列表同口径；真机反馈 2026-11-18：不能只列有标题的）。
*  选择即切换会话绑定（per-chat 状态），不写插件配置——会话绑定不是配置。 */
function conversationSelect(opts) {
	const options = [{
		label: "✨ 开启新对话",
		value: NEW_CONVERSATION_VALUE
	}];
	const seen = /* @__PURE__ */ new Set([NEW_CONVERSATION_VALUE]);
	for (const s of opts.chatSessions ?? []) {
		if (seen.has(s.sessionId)) continue;
		seen.add(s.sessionId);
		const isCurrent = s.sessionId === opts.currentSessionId;
		const name = s.title || s.sessionId.replace(/^session-/, "").slice(0, 13) + "…";
		const rel = relativeTime(s.updatedAt ?? 0);
		options.push({
			label: (isCurrent ? "📍 " : "") + name + " · " + rel,
			value: s.sessionId
		});
	}
	return selectStatic("conversation", "切换对话", options, (opts.currentSessionId && seen.has(opts.currentSessionId) ? opts.currentSessionId : void 0) ?? "__new_conversation__");
}
function buildSettingsPanel(opts) {
	const selects = settingsSelectElements(opts);
	const chatSelect = conversationSelect(opts);
	const elements = [
		{
			tag: "markdown",
			content: "<font color='grey'>选择后立即保存到插件配置（与 Web 设置页同步）· 切换对话 / 工作区从下一条消息起生效 · 本工作区共 " + (opts.sessionsTotal ?? 0) + " 个会话</font>"
		},
		settingsRow([{
			label: "对话",
			color: "indigo",
			select: chatSelect
		}]),
		settingsRow([{
			label: "模型",
			color: "blue",
			select: selects[1]
		}, {
			label: "强度",
			color: "turquoise",
			select: selects[2]
		}]),
		settingsRow([{
			label: "工作区",
			color: "green",
			select: selects[0]
		}, {
			label: "权限",
			color: "orange",
			select: selects[3]
		}])
	];
	if (opts.hasPendingPermission) elements.push({
		tag: "markdown",
		content: "<font color='red'>⚠️ 高权限档待确认：回复**确认**以应用（仅发起人有效，30s 内）</font>"
	});
	opts.titleError && "" + opts.titleError;
	return {
		tag: "collapsible_panel",
		expanded: false,
		vertical_spacing: "8px",
		header: {
			title: {
				tag: "markdown",
				content: "⚙️ **会话设置**"
			},
			background_color: "grey",
			vertical_align: "center",
			padding: "6px 0px 6px 10px",
			icon: {
				tag: "standard_icon",
				token: "down-small_outlined"
			},
			icon_position: "follow"
		},
		elements
	};
}
/** CardKit 2.0 select_static: the component fires card.action.trigger by
* default (official doc), with action.name = element name and
* action.option = the chosen value. behaviors carries the official-recommended
* custom回传参数 so action.value also names the control (belt and braces;
* the handler keys off action.name, not action.value). initial_option is a
* verified CardKit 2.0 field (官方文档：选项展示的初始内容). */
function selectStatic(name, placeholder, options, initial) {
	const element = {
		tag: "select_static",
		name,
		placeholder: {
			tag: "plain_text",
			content: placeholder
		},
		options: options.map((o) => ({
			text: {
				tag: "plain_text",
				content: o.label
			},
			value: o.value
		})),
		behaviors: [{
			type: "callback",
			value: { value: name }
		}]
	};
	if (initial && options.some((o) => o.value === initial)) element.initial_option = initial;
	return element;
}
/** P5 审批卡：工具名 + 原因 + [同意][拒绝] 两个回调按钮。
*  按钮 value 携带 callId（approve:<callId> / reject:<callId>），回调据此 resolve 对应审批。 */
function buildApprovalCard(toolName, reason, callId) {
	return richCard({
		title: "审批请求",
		color: "orange",
		lines: [
			"**需要审批**",
			"**工具**：" + (toolName || "未知"),
			...reason ? ["**原因**：" + reason] : []
		],
		buttons: [{
			text: "✅ 同意",
			value: "approve:" + (callId ?? "")
		}, {
			text: "⛔ 拒绝",
			value: "reject:" + (callId ?? "")
		}]
	});
}
/** P5 审批终态卡：就地替换审批卡（同 messageId 全量更新），按钮区换成结论文本，
*  卡片不消失、不撤回——像用户给 DSH 发了一条决策消息那样留痕。 */
function buildApprovalFinalCard(toolName, outcome) {
	const ok = outcome === "allowed-once";
	const lines = [ok ? "✅ **你已同意**：" + (toolName || "该操作") : outcome === "rejected" ? "⛔ **你已拒绝**：" + (toolName || "该操作") : "🚫 **审批已取消**：" + (toolName || "该操作"), "（connect-lark 审批记录，留存于本对话）"];
	return richCard({
		title: "审批结果",
		color: ok ? "green" : "red",
		lines
	});
}
// src/overrides.ts
/** Session-identity fingerprint for a cwd (simple polynomial, cache invalidation
*  only): 改工作区必须换新会话才能生效（cwd 是会话出身属性）。 */
function cwdTag(path) {
	if (!path) return "";
	let h = 5381;
	for (let i = 0; i < path.length; i++) h = (h << 5) + h + path.charCodeAt(i) >>> 0;
	return "@" + h.toString(36);
}
// src/session-map.ts
/** 状态文件位置：DSH home 下（DSH_HOME 优先，缺省 ~/.dsh）。可经 env 覆盖以便测试。 */
function defaultStatePath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "connect-lark-sessions.json");
}
/** 旧版遗留字段（曾把模型/强度/权限存在 per-chat 状态里 = 第二套配置）。
*  2026-11-17 起事实源只有插件配置，这些字段一律丢弃并在下次写回时抹掉。 */
const LEGACY_FIELDS = [
	"provider",
	"model",
	"reasoningEffort",
	"permissionPreset"
];
/** 读状态文件（不存在/损坏 → 空对象；绝不因坏文件崩插件）。
*  顺手清掉旧版遗留的设置字段——它们曾构成第二套配置事实源，不能继续留在文件里。 */
function loadStates(path) {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out = {};
		for (const [chatId, raw] of Object.entries(parsed)) {
			if (!raw || typeof raw !== "object") continue;
			const state = { ...raw };
			const bag = state;
			for (const field of LEGACY_FIELDS) delete bag[field];
			out[chatId] = state;
		}
		return out;
	} catch {
		return {};
	}
}
/** 原子写（P1-2：.tmp + rename，单进程无需锁）。 */
function saveStates(path, map) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = path + ".tmp";
	writeFileSync(tmp, JSON.stringify(map, null, 2));
	renameSync(tmp, path);
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
			slot.cardUpdateTimer = null;
			slot.cardDirty = false;
			slot.lastCardUpdateAt = 0;
			slot.runStartedAt = Date.now();
			slot.cardHeartbeat = null;
			slot.phase = void 0;
			slot.lastThinkingAt = void 0;
			slot.thinkingEndedAt = void 0;
			const unsub = this.opts.subscribe(agent, sessionId, (delta, kind) => {
				if (kind === "reasoning") {
					slot.phase = "thinking";
					slot.thinkingText = truncateTail(slot.thinkingText + delta, MAX_THINKING_CHARS);
					slot.lastThinkingAt = Date.now();
					this.opts.onThinking?.(slot, delta);
				} else if (kind === "tool") {
					slot.phase = "tool";
					this.opts.onPhase?.(slot);
				} else {
					if (slot.thinkingText && slot.thinkingEndedAt === void 0) slot.thinkingEndedAt = Date.now();
					slot.phase = "text";
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
		if (slot.cardUpdateTimer) {
			clearTimeout(slot.cardUpdateTimer);
			slot.cardUpdateTimer = null;
		}
		if (slot.cardHeartbeat) {
			clearInterval(slot.cardHeartbeat);
			slot.cardHeartbeat = null;
		}
		slot.cardDirty = false;
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
		if (slot.cardUpdateTimer) {
			clearTimeout(slot.cardUpdateTimer);
			slot.cardUpdateTimer = null;
		}
		if (slot.cardHeartbeat) {
			clearInterval(slot.cardHeartbeat);
			slot.cardHeartbeat = null;
		}
		slot.cardDirty = false;
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
			if (slot.cardHeartbeat) {
				clearInterval(slot.cardHeartbeat);
				slot.cardHeartbeat = null;
			}
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
			const avatar = item.avatar;
			const avatarUrl = typeof avatar === "object" && avatar !== null ? String(avatar.avatar_240 ?? avatar.avatar_640 ?? "") : typeof avatar === "string" ? avatar : "";
			users.push({
				name: String(item.name ?? item.en_name ?? item.open_id),
				openId: String(item.open_id),
				isManager: item.is_tenant_manager === true,
				...item.email ? { email: String(item.email) } : {},
				...avatarUrl ? { avatar: avatarUrl } : {}
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
		let pageToken = "";
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = await client.contact.v3.user.findByDepartment({ params: {
				user_id_type: "open_id",
				department_id: "0",
				page_size: PAGE_SIZE,
				...pageToken ? { page_token: pageToken } : {}
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
			pageToken = String(response?.data?.page_token ?? "");
			if (!pageToken) break;
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
/**
* 列出机器人所在的群（im/v1/chats）。机器人没被拉进任何群时返回空数组，
* 这不是错误：群目录只是给配置页多一个「按群名搜索」的入口。
*/
async function fetchDirectoryChats(client) {
	const list = client.im?.v1?.chat?.list;
	if (typeof list !== "function") return [];
	try {
		const response = await list.call(client.im?.v1?.chat, { params: { page_size: 50 } });
		if (response?.code !== 0) return [];
		const chats = [];
		for (const item of response?.data?.items ?? []) {
			const chatId = item.chat_id;
			if (!chatId) continue;
			const avatar = item.avatar;
			const avatarUrl = typeof avatar === "object" && avatar !== null ? String(avatar.avatar_240 ?? avatar.avatar_640 ?? "") : typeof avatar === "string" ? avatar : "";
			chats.push({
				name: String(item.name ?? chatId),
				chatId: String(chatId),
				...avatarUrl ? { avatar: avatarUrl } : {}
			});
		}
		return chats;
	} catch {
		return [];
	}
}
/**
* 一次拿到人和群：配置页用同一个搜索框找人、找群。
*
* @param client - 飞书 SDK 客户端（通常是 channel.rawClient）
* @returns 通讯录 + 群聊目录；失败时 ok=false 且带原因
*/
async function fetchDirectory(client) {
	const users = await fetchDirectoryUsers(client);
	if (!users.ok) return {
		ok: false,
		users: [],
		chats: [],
		reason: users.reason
	};
	const chats = await fetchDirectoryChats(client);
	return {
		ok: true,
		users: users.users,
		chats,
		...users.manager ? { manager: users.manager } : {}
	};
}
// src/directory-service.ts
/** 本机端口。dsh-remote 占用 9091，这里错开。 */
const DIRECTORY_PORT = 9092;
/**
* 起一个只读的本机 HTTP 面，给配置页提供「可授权用户」列表。
*
* @param options - 目录来源与跨域白名单
* @returns 已监听的目录服务
*/
async function startDirectoryService(options) {
	return listen(options, options.port ?? 9092);
}
async function listen(options, port) {
	const origins = options.allowedOrigins ?? /* @__PURE__ */ new Set();
	const server = createServer((req, res) => {
		const requestOrigin = String(req.headers.origin ?? "");
		if (requestOrigin && !origins.has(requestOrigin)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				ok: false,
				users: [],
				chats: [],
				reason: "origin not allowed"
			}));
			return;
		}
		if (requestOrigin) {
			res.setHeader("Access-Control-Allow-Origin", requestOrigin);
			res.setHeader("Vary", "Origin");
		}
		if (req.method === "OPTIONS") {
			res.setHeader("Access-Control-Allow-Methods", "GET");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			res.writeHead(204);
			res.end();
			return;
		}
		if (req.method !== "GET" || !req.url?.startsWith("/lark-api/directory")) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				ok: false,
				users: [],
				reason: "not found"
			}));
			return;
		}
		options.directory().then((result) => {
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
	normalizeYamlRoundTrip(out);
	return out;
}
/** 宿主 configEditor 写 YAML 不加引号：effort 档位 id "off" 会被 YAML 1.1 解析成布尔 false
*  （真机实证 2026-11-17：选 Off → 落盘 `reasoningEffort: off` → 读回 false）。
*  这里把布尔回读归一回档位 id，保证卡片显示与会话创建拿到合法值。 */
function normalizeYamlRoundTrip(out) {
	if (out.reasoningEffort === false) out.reasoningEffort = "off";
	else if (out.reasoningEffort === true) out.reasoningEffort = "";
}
const inject = [
	"agents",
	"llm",
	"attachments",
	"credentials",
	"sessionController",
	"permissionPresets",
	"workspaceRegistry",
	"sessionQuery",
	"settings"
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
/** Send a reply with a deadline so a hung request cannot stall the chat. */
async function sendBounded(chan, chatId, markdown) {
	if (!(await withTimeout(chan.send(chatId, { markdown }), 15e3)).ok) throw new Error("send timed out");
}
/** 这个 DSH 实例对外公布的地址（隧道域名等），浏览器页面的 origin 就是它。 */
function advertisedOrigin(ctx) {
	try {
		const url = ctx?.get?.("webApp")?.getAdvertisedUrl?.();
		if (typeof url !== "string") return "";
		return new URL(url).origin;
	} catch {
		return "";
	}
}
/** 本机回环地址：直接用 http://127.0.0.1:8083 打开页面时也该能用。 */
function loopbackOrigins() {
	const origins = [];
	for (let port = 3e3; port <= 9200; port++) origins.push("http://127.0.0.1:" + String(port), "http://localhost:" + String(port));
	return origins;
}
function withTimeout(promise, ms) {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve({ ok: false });
			}
		}, ms);
		timer.unref?.();
		Promise.resolve(promise).then((value) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({
					ok: true,
					value
				});
			}
		}, () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ ok: false });
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
	if (plain.accessMode === "app") return true;
	if (plain.accessMode === "open") {
		if (chatType === "group") return plain.groupAllowlist.length === 0 || plain.groupAllowlist.includes(chatId);
		if (plain.openId) return plain.openId === senderId;
		return true;
	}
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
/**
* 让一个会话成为 DSH「一等公民」：
*  1) 走宿主标准 sessionController.create（幂等：该 id 已存则复用）→ 进标准会话库 + 投影缓存；
*  2) 用 workspaceRegistry.resolveByPath(cwd)（canonical realpath 匹配）把会话挂进工作区归属
*     → Web 左栏当场可见（旧代码用 workspaces.find(精确路径) 建会话，冷会话不在归属表，故不可见）；
*  3) 命名（有 title 时）。
* 全程只调宿主公开 API，不写配置、不写 patch、不触发 HMR。
*/
async function ensureFirstClass(ctx, sessionId, cwd, title) {
	const ws = await ctx.workspaceRegistry?.resolveByPath?.(cwd);
	try {
		if (ws) await ctx.sessionController?.create?.({
			workspaceId: ws.id,
			sessionId
		});
		else await ctx.sessionController?.create?.({
			cwd,
			sessionId
		});
	} catch (error) {
		if (!/writer-held|already exists|already registered|active write handle|reusable/i.test(error.message)) ctx.logger?.warn?.("[connect-lark] first-class create: " + error.message);
	}
	try {
		if (ws) await ws.attachSession?.(sessionId);
	} catch (error) {
		ctx.logger?.warn?.("[connect-lark] first-class attachSession: " + error.message);
	}
	if (title) try {
		await ctx.sessionController?.rename?.({
			sessionId,
			title
		});
	} catch {}
}
/**
* P4：列出可 resume 的历史会话（sessionController.list）。
* 双版本形状差异归一化：rc.2 的 list() 返回 SessionSummary[]；rc.3 返回
* { items: SessionSummary[] }。此处统一为会话行（只取清单需要的字段）。
* 失败/无会话 → 空数组（卡片显示「暂无历史会话」）。
*/
/** 历史卡最多展示的会话条数（真机实测：实例里 ~300 会话时全量下拉会让飞书建卡超时）。 */
const HISTORY_LIMIT = 20;
/** 冷读一个会话的标题（session/title 事件的最后一个值）。
*  优先用 sessionQuery.readSession（完整日志）；不可用时 inspectSession 读投影。
*  读不到 → 空串（调用方用占位标题）。 */
async function readColdSessionTitle(query, sessionId) {
	if (!query) return "";
	if (typeof query.readSession === "function") {
		const titles = ((await query.readSession(sessionId))?.events ?? []).filter((e) => e?.type === "session/title" && typeof e?.data?.title === "string");
		return titles[titles.length - 1]?.data?.title ?? "";
	}
	if (typeof query.inspectSession === "function") return String(await query.inspectSession(sessionId, (session) => {
		try {
			const titles = (session?.snapshotEvents?.() ?? []).filter((e) => e?.type === "session/title" && typeof e?.data?.title === "string");
			return titles[titles.length - 1]?.data?.title ?? "";
		} catch {
			return "";
		}
	}) ?? "");
	return "";
}
async function listSessions(ctx, limit = HISTORY_LIMIT, cwdFilter, coldRead = true) {
	try {
		const ctrl = ctx.sessionController;
		if (!ctrl?.list) return {
			sessions: [],
			total: 0
		};
		const raw = await ctrl.list();
		const mapped = (Array.isArray(raw) ? raw : raw?.items ?? []).filter((r) => typeof (r?.sessionId ?? r?.id) === "string" && (r.sessionId ?? r.id)).map((r) => ({
			sessionId: r.sessionId ?? r.id,
			title: r.projections?.values?.title ?? r.title ?? "",
			cwd: typeof r.cwd === "string" ? r.cwd : void 0,
			updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
			blank: typeof r.blank === "boolean" ? r.blank : void 0
		}));
		const scoped = (cwdFilter === void 0 ? mapped : mapped.filter((s) => s.cwd === cwdFilter)).sort((a, b) => b.updatedAt - a.updatedAt);
		const total = scoped.length;
		const page = scoped.slice(0, limit);
		const titles = /* @__PURE__ */ new Map();
		const query = ctx.get?.("sessionQuery");
		let titleError;
		const coldCount = coldRead === true ? page.length : coldRead === false ? 0 : coldRead;
		const coldTargets = page.slice(0, coldCount);
		if (query && typeof query.readTitleSnapshots === "function") try {
			const outcome = coldTargets.length ? await withTimeout(query.readTitleSnapshots(coldTargets.map((s) => s.sessionId)), 1e4) : {
				ok: true,
				value: []
			};
			if (!outcome?.ok) throw new Error("readTitleSnapshots timed out");
			const results = outcome.value ?? [];
			let hits = 0;
			results.forEach((r, i) => {
				const raw = r?.status === "fulfilled" ? r.value?.title : void 0;
				const title = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof raw.title === "string" ? raw.title : void 0;
				if (title) {
					titles.set(coldTargets[i].sessionId, title);
					hits++;
				} else if (r?.status === "rejected") titleError = "readTitleSnapshots rejected: " + String(r.reason?.message ?? r.reason).slice(0, 120);
			});
			if (hits === 0 && results.length > 0) {
				const first = results[0];
				const keys = first?.status === "fulfilled" ? Object.keys(first.value ?? {}).join(",") : first?.status;
				titleError = "0/" + results.length + " 命中，首个快照 keys=[" + keys + "]";
			}
		} catch (e) {
			titleError = "readTitleSnapshots threw: " + e.message.slice(0, 120);
		}
		else if (coldCount > 0 && query) {
			const probeTitle = async (sessionId) => {
				try {
					const result = await withTimeout(readColdSessionTitle(query, sessionId), 5e3);
					if (result.ok && result.value) titles.set(sessionId, result.value);
				} catch {}
			};
			await Promise.all(coldTargets.map((s) => probeTitle(s.sessionId)));
		} else if (coldCount > 0) titleError = "sessionQuery service unavailable";
		for (const s of page) s.title = titles.get(s.sessionId) ?? "";
		return {
			sessions: page,
			total,
			titleError
		};
	} catch (e) {
		ctx.logger?.warn?.("[connect-lark] list sessions failed: " + e.message);
		return {
			sessions: [],
			total: 0,
			titleError: "list threw: " + e.message.slice(0, 120)
		};
	}
}
/** Create a per-chat agent, reusing live agents and resuming persisted sessions. */
async function createOrResumeAgent(ctx, sessionId, meta, agentOptions, permissionPreset = "") {
	const applyPreset = (agent) => {
		if (permissionPreset) ctx.permissionPresets.set(agent.session, permissionPreset);
		const opts = agentOptions;
		if (opts?.provider && opts?.model) try {
			agent.model?.select?.({
				provider: opts.provider,
				model: opts.model,
				...opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}
			});
		} catch {}
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
/** 终稿思考面板保留的尾部字符数：CardKit 单卡有 ~30KB 上限，长思考截尾防更新失败。 */
const FINAL_THINKING_TAIL = 4e3;
/** 卡片更新节流：每个 token 一次 PATCH 会被飞书限流，卡片反而像冻结。 */
const CARD_UPDATE_INTERVAL_MS = 900;
/** 把运行失败翻译成用户能行动的话：上游不可达 = DSH 服务没开。 */
function friendlyRunFailure(error) {
	const m = String(error.message || error);
	if (/ECONNREFUSED|fetch failed|connect|socket|hang/i.test(m)) return "DSH 服务未开启——请先启动本机 DSH，再发送消息。";
	return "**运行失败：** " + m;
}
/** Update one streaming rich card with the latest answer and optional CoT.
* final=true 时思考过程收进折叠面板（截尾）；legacyThinking=true 渲染旧版引用块，
* 作为折叠面板被飞书拒绝时的回退版式。 */
async function updateRunCard(slot, thinkingPolicy, opts = {}) {
	if (!slot.streamController) return;
	const lines = [];
	const thinkingQuoted = () => slot.thinkingText.split("\n").map((line) => "> " + line).join("\n");
	const showThinking = thinkingPolicy === "cot-visible" && Boolean(slot.thinkingText);
	const bodyStarted = Boolean(slot.accumulatedText) || Boolean(opts.final);
	const phaseTitle = slot.phase === "tool" ? "正在调用工具…" : slot.phase === "text" ? "正在生成…" : "正在思考…";
	const title = slot.failedWith ? "DSH 回复" : opts.final ? "DSH 回复" : phaseTitle;
	const thinkingTail = (maxLines) => {
		const all = slot.thinkingText.split("\n");
		return (all.length > maxLines ? "…（上文略）\n" : "") + all.slice(-maxLines).join("\n");
	};
	const thinkingSeconds = slot.thinkingEndedAt && slot.runStartedAt ? Math.max(1, Math.round((slot.thinkingEndedAt - slot.runStartedAt) / 1e3)) : null;
	let panels;
	if (slot.failedWith) lines.push("**" + friendlyRunFailure(slot.failedWith) + "**");
	else if (showThinking && !bodyStarted && !opts.legacyThinking) lines.push("**思考过程**", thinkingTail(3));
	else if (showThinking && !opts.legacyThinking) {
		slot.thinkingText.length > FINAL_THINKING_TAIL ? "" + slot.thinkingText.slice(-4e3) : slot.thinkingText;
		panels = [{
			title: thinkingSeconds ? "思考过程 · " + thinkingSeconds + "s" : "思考过程",
			content: thinkingQuoted()
		}];
		lines.push(slot.accumulatedText || "本次回复没有文本输出。");
	} else if (showThinking) lines.push("**思考过程**", thinkingQuoted(), "---", slot.accumulatedText || "正在生成回复…");
	else if (slot.accumulatedText) lines.push(slot.accumulatedText);
	else if (opts.final) lines.push("本次回复没有文本输出。");
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const buttons = [{
		text: "dsh-nano-market",
		url: "https://github.com/oh-summy/dsh-nano-market"
	}];
	const appendElements = opts.footer?.panelArgs ? [buildSettingsPanel(opts.footer.panelArgs)] : void 0;
	const card = richCard({
		title,
		headerSubtitle: opts.footer?.statusLine,
		color: opts.final ? "green" : "blue",
		lines,
		panels,
		appendElements,
		note: "connect-lark · by @oh-summy · " + timestamp,
		buttons
	});
	await slot.streamController.update(card);
	if (appendElements) opts.footer?.onBuilt?.(card);
}
/** 终稿更新：先试折叠面板版式，被飞书拒绝时回退旧版引用块。 */
async function finalizeRunCard(slot, thinkingPolicy, footer) {
	if (!slot.streamController) return;
	try {
		await updateRunCard(slot, thinkingPolicy, {
			final: true,
			footer
		});
	} catch (panelError) {
		try {
			await updateRunCard(slot, thinkingPolicy, {
				final: true,
				legacyThinking: true,
				footer
			});
		} catch {
			throw panelError;
		}
	}
}
function apply(ctx, config = {}) {
	let plain = plainConfig(config);
	let channel = null;
	let runManager = null;
	let unsubMessage = null;
	let unsubCardAction = null;
	let directoryService = null;
	let managerOpenId = "";
	let unsubEvents = [];
	let generation = 0;
	let transition = Promise.resolve();
	const chatTypeCache = /* @__PURE__ */ new Map();
	const lastReplyCards = /* @__PURE__ */ new Map();
	const sessionChat = /* @__PURE__ */ new Map();
	let approvalSeq = 0;
	const pendingApprovals = /* @__PURE__ */ new Map();
	const APPROVAL_TTL_MS = 3e5;
	const mediaRegistered = /* @__PURE__ */ new Set();
	const statePath = process.env.CONNECT_LARK_SESSION_MAP || defaultStatePath();
	const chatStates = loadStates(statePath);
	try {
		if (existsSync(statePath) && /"(provider|model|reasoningEffort|permissionPreset)"/.test(readFileSync(statePath, "utf8"))) {
			saveStates(statePath, chatStates);
			ctx.logger?.info?.("[connect-lark] sanitized legacy per-chat settings from state file (single source = plugin config)");
		}
	} catch {}
	const chatState = (chatId) => chatStates[chatId] ?? { updatedAt: 0 };
	const touchState = (chatId, patch) => {
		const cur = chatStates[chatId] ?? { updatedAt: 0 };
		chatStates[chatId] = {
			...cur,
			...patch,
			updatedAt: Date.now()
		};
		try {
			saveStates(statePath, chatStates);
		} catch (e) {
			ctx.logger?.warn?.("[connect-lark] save per-chat state: " + e.message);
		}
	};
	/** 该 chat 当前的工作区 cwd：绑定会话的工作区 > 插件配置的 defaultPath > 宿主 cwd。 */
	const currentCwd = (chatId) => chatState(chatId).cwd || plain.defaultPath || process.cwd();
	/** 默认会话 id：chat + 工作区指纹（工作区变了 → 新会话；切回原工作区 → 继续原会话）。 */
	const deterministicSessionId = (chatId, cwd) => "connect-lark:" + chatId + cwdTag(cwd);
	/** 解除会话绑定（换工作区/重开会话）：下一条消息按配置重新推导默认会话。 */
	const clearSessionBinding = (chatId) => {
		const cur = chatStates[chatId];
		if (!cur) return;
		delete cur.sessionId;
		delete cur.cwd;
		cur.updatedAt = Date.now();
		try {
			saveStates(statePath, chatStates);
		} catch (e) {
			ctx.logger?.warn?.("[connect-lark] save per-chat state: " + e.message);
		}
	};
	/** 给 owned-per-chat 的 agent 注册桥内发媒体工具：agent 生成图片/文件后
	*  直接经当前 bot 发给用户，而不是绕道 lark-cli 等其他应用（真机反馈 2026-11-13）。 */
	const registerMediaTool = (agent, chatId, sessionId) => {
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
						path: {
							type: "string",
							description: "要发送的本机文件绝对路径"
						},
						caption: {
							type: "string",
							description: "可选说明文字，随文件以一条纯文本消息发送"
						}
					},
					required: ["path"],
					additionalProperties: false
				},
				output: { schema: {
					type: "object",
					properties: {
						ok: {
							type: "boolean",
							description: "是否发送成功"
						},
						kind: {
							type: "string",
							description: "image 或 file"
						},
						messageId: {
							type: "string",
							description: "飞书消息 id"
						},
						error: {
							type: "string",
							description: "失败原因"
						}
					},
					additionalProperties: false
				} },
				async execute(args, exec) {
					const ch = channel;
					if (!ch) return {
						ok: false,
						error: "飞书连接不可用"
					};
					const sid = exec?.agent?.session?.id ?? sessionId;
					const target = sessionChat.get(sid);
					if (!target) return {
						ok: false,
						error: "找不到该会话对应的飞书对话（可能已过期或被清理）"
					};
					const info = await stat(args.path).catch(() => null);
					if (!info || !info.isFile()) return {
						ok: false,
						error: "文件不存在或不可读: " + args.path
					};
					const ext = path.extname(args.path).toLowerCase();
					const isImage = [
						".png",
						".jpg",
						".jpeg",
						".webp",
						".gif"
					].includes(ext);
					const input = isImage ? { image: { source: args.path } } : { file: {
						source: args.path,
						fileName: path.basename(args.path)
					} };
					const sent = await withTimeout(ch.send(target, input), 3e4);
					if (!sent.ok) return {
						ok: false,
						error: "发送超时（30s）"
					};
					if (args.caption) Promise.resolve(ch.send(target, { text: args.caption })).catch(() => {});
					return {
						ok: true,
						kind: isImage ? "image" : "file",
						messageId: sent.value?.messageId
					};
				}
			});
			ctx.logger?.info?.("[connect-lark] feishu_send_media tool registered for " + sessionId);
		} catch (e) {
			ctx.logger?.warn?.("[connect-lark] media tool register skipped: " + e.message);
		}
	};
	/** 重建最近一张回复卡的内嵌设置面板（唯一实现：同步、零 await、零网络）。
	*  overrides 用于「用户刚选的模型」尚未写入配置时，面板先按新模型渲染
	*  （档位必须跟着所选模型走，否则会选到别的模型的档位 → DSH 拒绝该 effort）。
	*  卡片回调里直接用返回值就地更新；其他场景用 fire-and-forget。 */
	const rebuildReplyCard = (chatId, overrides) => {
		const stored = lastReplyCards.get(chatId);
		if (!stored) return void 0;
		const args = settingsCardArgs(chatId, overrides);
		const effortList = effortOptionsFor(args);
		const clone = JSON.parse(JSON.stringify(stored));
		const els = clone.body?.elements ?? [];
		const idx = els.findIndex((e) => e.tag === "collapsible_panel" && typeof e.header?.title?.content === "string" && String(e.header.title.content).startsWith("⚙️"));
		if (idx < 0) return void 0;
		els[idx] = buildSettingsPanel({
			...args,
			effortList
		});
		if (clone.header && typeof clone.header === "object") {
			const shown = buildDisplay(chatId) ?? {};
			if (overrides?.model) shown.model = overrides.model;
			clone.header.subtitle = {
				tag: "plain_text",
				content: settingsStatusLine(shown, plain.agentOwnership === "attach-gui")
			};
		}
		lastReplyCards.set(chatId, clone);
		return clone;
	};
	const dedupTable = /* @__PURE__ */ new Map();
	const dedupClaim = (key) => {
		const now = Date.now();
		if (dedupTable.has(key) && (dedupTable.get(key) ?? 0) > now) return false;
		if (dedupTable.size > 500) {
			for (const [k, ts] of dedupTable) if (ts <= now) dedupTable.delete(k);
		}
		dedupTable.set(key, now + 6e4);
		return true;
	};
	const pendingConfirms = /* @__PURE__ */ new Map();
	const CONFIRM_TTL_MS = 3e4;
	let settingsData = null;
	const refreshSettingsData = async () => {
		try {
			const [catalog, sessions] = await Promise.all([ctx.sessionController.modelCatalog(), listSessions(ctx, 300, void 0, 80).catch(() => ({
				sessions: [],
				total: 0,
				titleError: "list threw in refresh"
			}))]);
			const workspaces = (ctx.workspaceRegistry?.list?.() ?? []).map((w) => ({
				id: w.id,
				title: w.title,
				path: w.path
			}));
			const permCat = ctx.permissionPresets?.catalog?.() ?? {
				options: [],
				defaultPreset: ""
			};
			settingsData = {
				catalog,
				workspaces,
				permissions: permCat.options ?? [],
				defaultPermission: permCat.defaultPreset ?? "",
				sessions: sessions.sessions,
				sessionsTotal: sessions.total,
				titleError: sessions.titleError
			};
		} catch (e) {
			ctx.logger?.warn?.("[connect-lark] settings data refresh failed: " + e.message);
		}
	};
	const settingsCardArgs = (chatId, overrides) => {
		const st = chatState(chatId);
		const wsPath = st.cwd || plain.defaultPath || process.cwd();
		const ws = wsPath ? settingsData?.workspaces.find((w) => w.path === wsPath) : void 0;
		const defaultTitle = wsPath ? "工作区（" + wsPath.split("/").filter(Boolean).pop() + "）" : "默认工作区";
		const provider = overrides?.provider ?? plain.provider ?? "";
		const model = overrides?.model ?? plain.model ?? "";
		const effort = overrides?.reasoningEffort !== void 0 ? overrides.reasoningEffort : plain.reasoningEffort ?? "";
		const hasModel = Boolean(provider && model);
		const currentSessionId = st.sessionId || deterministicSessionId(chatId, wsPath || process.cwd());
		const chatSessions = (settingsData?.sessions ?? []).filter((s) => (wsPath === void 0 || s.cwd === wsPath) && s.blank !== true).slice(0, 15).map((s) => ({
			sessionId: s.sessionId,
			title: s.title,
			cwd: s.cwd,
			updatedAt: s.updatedAt
		}));
		if (!chatSessions.some((s) => s.sessionId === currentSessionId)) chatSessions.unshift({
			sessionId: currentSessionId,
			title: "",
			cwd: wsPath,
			updatedAt: Date.now()
		});
		return {
			catalog: settingsData?.catalog ?? { groups: [] },
			workspaces: settingsData?.workspaces ?? [],
			permissions: settingsData?.permissions ?? [],
			defaultPermission: settingsData?.defaultPermission ?? "",
			current: {
				workspaceId: ws ? ws.id : DEFAULT_OPTION_VALUE,
				provider: hasModel ? provider : void 0,
				model: hasModel ? model : void 0,
				reasoningEffort: effort || void 0,
				permission: plain.permissionPreset || void 0
			},
			hasPendingPermission: pendingConfirms.has(chatId),
			defaultWorkspaceTitle: defaultTitle,
			chatSessions,
			currentSessionId,
			sessionsTotal: settingsData?.sessionsTotal ?? 0,
			titleError: settingsData?.titleError
		};
	};
	/** 需要二次确认的高危档位（宿主语义，dsh-permission-presets）：
	*  - danger-full-access：sandbox 全权 + approval **never**（永不询问，无提示直接放行）← 最危险
	*  - auto：sandbox 全权 + approval **ask**（每次调用都审查）← 比上者安全，不需确认
	*  只有「永不询问的全权访问」才需要用户点头。 */
	const isHighPermission = (option) => option === "danger-full-access";
	/** 候选配置的可读展示名（toast A→B 的 next 值）——不依赖配置已提交。 */
	const nextLabelOf = (field, partial) => {
		if (field === "workspace") {
			if (!partial.defaultPath) return "默认工作区";
			return (settingsData?.workspaces.find((w) => w.path === partial.defaultPath))?.title ?? partial.defaultPath;
		}
		if (field === "model") {
			const group = (settingsData?.catalog?.groups ?? []).find((g) => g.id === partial.provider);
			const m = group?.models?.find((mm) => mm.id === partial.model);
			return (group?.name ? group.name + " · " : "") + (m?.name ?? partial.model ?? "跟随 DSH 默认");
		}
		if (field === "effort") {
			if (!partial.reasoningEffort) return "跟随模型默认";
			return (((settingsData?.catalog?.groups ?? []).find((g) => g.id === partial.provider)?.models?.find((mm) => mm.id === partial.model))?.reasoning?.efforts?.find((x) => x.id === partial.reasoningEffort))?.name ?? partial.reasoningEffort;
		}
		if (field === "permission") {
			if (!partial.permissionPreset) return "跟随 DSH 默认";
			return (settingsData?.permissions.find((x) => x.value === partial.permissionPreset))?.name ?? partial.permissionPreset;
		}
		return "已设置";
	};
	/** 同步处理一次 select 回调：校验 → 生成该维度的候选值（高权限档先进 pending，
	*  确认后才进入候选）。候选由调用方经 writePluginConfig 写插件配置（唯一事实源），
	*  并由 applyDimension 补会话投影让当前会话立即生效。 */
	const applySelect = (chatId, name, option, openId) => {
		if (name === "workspace") {
			if (option === "__default__") return { partial: { defaultPath: "" } };
			const ws = (ctx.workspaceRegistry?.list?.() ?? []).find((w) => w.id === option);
			if (!ws) return { error: "未知工作区" };
			const switched = currentCwd(chatId) !== ws.path;
			return {
				partial: { defaultPath: ws.path },
				switchedWorkspace: switched,
				workspaceTitle: ws.title
			};
		}
		if (name === "model") {
			if (option === "__default__") return { partial: {
				provider: "",
				model: "",
				reasoningEffort: ""
			} };
			const sep = option.indexOf(":");
			if (sep <= 0) return { error: "无效的模型选项" };
			return { partial: {
				provider: option.slice(0, sep),
				model: option.slice(sep + 1),
				reasoningEffort: ""
			} };
		}
		if (name === "effort") {
			if (option === "__default__") return { partial: { reasoningEffort: "" } };
			return { partial: { reasoningEffort: option } };
		}
		if (name === "permission") {
			const value = option === "__default__" ? settingsData?.defaultPermission ?? "" : option;
			if (isHighPermission(value)) {
				const now = Date.now();
				for (const [cid, p] of pendingConfirms) if (p.expiresAt <= now) pendingConfirms.delete(cid);
				pendingConfirms.set(chatId, {
					openId,
					permission: value,
					expiresAt: now + CONFIRM_TTL_MS
				});
				return { pendingHigh: true };
			}
			pendingConfirms.delete(chatId);
			return { partial: { permissionPreset: value } };
		}
		return { error: "未知控件" };
	};
	/** 配置写入口：**唯一**的配置保存路径（与 Web 设置页同一处）。
	*  走宿主 settings 服务 → configEditor → profile patch → loader 热更新，
	*  与 Web 设置页的 form.actions().save() 完全同源（同一份 cordis.patch.yml 配置）。
	*  绝不自己写 patch 文件：那会绕过宿主的原子写 + HMR 序列化（曾导致配置被截断）。 */
	const writePluginConfig = async (patch) => {
		const settings = ctx.get?.("settings");
		if (!settings?.mutate) throw new Error("宿主 settings 服务不可用，无法保存配置");
		const ns = "connect-lark";
		const ops = Object.entries(patch).map(([field, value]) => ({
			op: "set",
			path: [field],
			value: value === "" ? void 0 : value
		}));
		await settings.mutate(ns, ops);
	};
	/** 后台：把本次选择**写入插件配置**（与 Web 设置页同一份），并让当前会话立即生效。
	*  - 配置写：writePluginConfig → 宿主 settings.mutate → profile patch → loader 热更新；
	*  - 会话生效：模型/强度 → agent.model.select（会话投影，重启重放）；权限 → permissionPresets.set。
	*  两步分开报错：配置保存失败 ≠ 会话投影失败。权限切换可能被宿主拒绝
	*  （持久终端开着时不能改 sandbox 模式——真机实证 2026-11-17），此时配置已保存，
	*  新会话/关闭终端后按新配置生效，必须如实告知而不是笼统说「设置未生效」。 */
	const applyDimension = async (chan, chatId, controlName, partial, dedupKey) => {
		try {
			await writePluginConfig(partial);
			if (controlName === "workspace") {
				const fromCwd = currentCwd(chatId);
				plainWorkspaceTitle = (settingsData?.workspaces ?? []).find((w) => w.path === fromCwd)?.title ?? fromCwd.split("/").filter(Boolean).pop() ?? fromCwd;
				clearSessionBinding(chatId);
				const newCwd = partial.defaultPath || fromCwd;
				try {
					const created = await ctx.sessionController.create({ cwd: newCwd });
					const newId = created?.sessionId ?? created?.value?.sessionId;
					if (newId) {
						try {
							const ws = await ctx.workspaceRegistry?.resolveByPath?.(newCwd);
							if (ws) await ws.attachSession(newId);
						} catch {}
						touchState(chatId, {
							sessionId: newId,
							cwd: newCwd
						});
						try {
							await ctx.sessionController.rename({
								sessionId: newId,
								title: "新对话"
							});
						} catch {}
						const toWsTitle = (settingsData?.workspaces ?? []).find((w) => w.path === newCwd)?.title ?? newCwd.split("/").filter(Boolean).pop() ?? newCwd;
						const wsSessions = (settingsData?.sessions ?? []).filter((s) => s.cwd === newCwd && s.sessionId !== newId).slice(0, 12).map((s) => ({
							sessionId: s.sessionId,
							title: s.title,
							updatedAt: s.updatedAt
						}));
						try {
							await withTimeout(chan.send(chatId, { card: buildWorkspaceSwitchCard(plainWorkspaceTitle, toWsTitle, wsSessions) }), 8e3);
						} catch (sendError) {
							ctx.logger?.warn?.("[connect-lark] workspace switch card send failed: " + sendError.message);
							await sendBounded(chan, chatId, "🔄 **已切换工作区** · " + nowStamp() + "\n从 **" + (plainWorkspaceTitle || "未知") + "** 切换至 **" + toWsTitle + "** · 已开启新对话（不继承历史）\n可在「会话设置 → 对话」下拉接回之前工作区的历史会话");
						}
					}
				} catch (e2) {
					ctx.logger?.warn?.("[connect-lark] workspace-switch session create failed: " + e2.message);
				}
				return;
			}
			try {
				const cwd = currentCwd(chatId);
				const id = chatState(chatId).sessionId || deterministicSessionId(chatId, cwd);
				if ((settingsData?.sessions.find((s) => s.sessionId === id))?.blank === true) {
					ctx.logger?.info?.("[connect-lark] target session is blank; skip projection (config will apply at creation) id=" + id);
					return;
				}
				if (Object.values(partial).every((v) => v === "" || v === void 0)) {
					ctx.logger?.info?.("[connect-lark] dimension set to follow DSH default; skip session projection");
					return;
				}
				await ensureFirstClass(ctx, id, cwd);
				const { agent } = await createOrResumeAgent(ctx, id, { cwd }, {}, plain.permissionPreset);
				if (controlName === "model" || controlName === "effort") {
					const sel = resolveAgentModelOptions(plain, await ctx.sessionController.modelCatalog());
					agent.model?.select?.(sel);
				}
				if (controlName === "permission") {
					const p = plain.permissionPreset || (settingsData?.defaultPermission ?? "");
					if (p) ctx.permissionPresets?.set?.(agent.session, p);
				}
			} catch (e) {
				ctx.logger?.warn?.("[connect-lark] config saved but session projection failed: " + e.message);
				Promise.resolve(chan.send(chatId, { markdown: "✅ 已保存到插件配置（Web 设置页同步可见）\n⚠️ 当前会话未能立即切换：" + e.message + "\n新对话（或关闭持久终端后）会按新配置生效" })).catch(() => {});
			}
		} catch (e) {
			ctx.logger?.warn?.("[connect-lark] apply dimension failed: " + e.message);
			if (dedupKey) dedupTable.delete(dedupKey);
			Promise.resolve(chan.send(chatId, { markdown: "⚠️ 设置未生效：" + e.message + "（请重试）" })).catch(() => {});
		}
	};
	/** 终稿卡片底部状态行的展示值（读插件配置——与 Web 设置页同一份）。 */
	const buildDisplay = (chatId) => {
		const st = chatId ? chatState(chatId) : {};
		const d = {};
		const wsPath = st.cwd || plain.defaultPath;
		if (wsPath) d.workspace = (settingsData?.workspaces.find((w) => w.path === wsPath))?.title ?? wsPath;
		if (plain.model) {
			const group = (settingsData?.catalog?.groups ?? []).find((g) => g.id === plain.provider);
			const m = group?.models?.find((mm) => mm.id === plain.model);
			d.model = (group?.name ? group.name + " · " : "") + (m?.name ?? plain.model);
		}
		if (plain.reasoningEffort) d.effort = (((settingsData?.catalog?.groups ?? []).find((g) => g.id === plain.provider)?.models?.find((mm) => mm.id === plain.model))?.reasoning?.efforts?.find((x) => x.id === plain.reasoningEffort))?.name ?? plain.reasoningEffort;
		if (plain.permissionPreset) d.permission = (settingsData?.permissions.find((x) => x.value === plain.permissionPreset))?.name ?? plain.permissionPreset;
		return d;
	};
	/** 思考强度选项——同步计算，零网络（catalog 的档位由宿主用 resolveModelInfo 精确路由解析
	*  填充，与 Web 选择器同源；实测 MiniMax = Low/Medium/High/Xhigh/Max、Agnes = Off/High）。
	*  绝不在卡片回调里 await 网络请求：飞书回调窗口约 3s，超时会报「回调服务超时」。 */
	const effortOptionsFor = (args) => effortOptions(currentModelValue(args.current, args.catalog), args.catalog);
	let plainWorkspaceTitle = "";
	/** 本地时间戳（消息里的切换记录用）：2026-11-18 14:38 */
	const nowStamp = () => {
		const d = /* @__PURE__ */ new Date();
		const p = (n) => String(n).padStart(2, "0");
		return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
	};
	/** 会话显示名：有标题用标题，无标题用 id 前缀（与「对话」下拉同规则）。 */
	const sessionDisplayName = (sessionId) => {
		const row = (settingsData?.sessions ?? []).find((s) => s.sessionId === sessionId);
		if (row?.title) return row.title;
		return sessionId.replace(/^session-/, "").slice(0, 13) + "…";
	};
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
				outbound: { allowedFileDirs: [
					os.homedir(),
					process.cwd(),
					...plain.defaultPath ? [plain.defaultPath] : []
				] },
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
			managerOpenId = "";
			try {
				const probe = await withTimeout(fetchDirectoryUsers(chan.rawClient), 5e3);
				const directory = probe.ok ? probe.value : void 0;
				if (directory && directory.ok && directory.manager) {
					managerOpenId = directory.manager.openId;
					ctx.logger?.info?.("[connect-lark] tenant manager detected");
				}
			} catch (e) {
				ctx.logger?.warn?.("[connect-lark] manager lookup failed: " + e.message);
			}
			if (!currentAlive()) return;
			try {
				const allowed = /* @__PURE__ */ new Set(["null"]);
				for (const candidate of [advertisedOrigin(ctx), ...loopbackOrigins()]) if (candidate) allowed.add(candidate);
				directoryService = await startDirectoryService({
					allowedOrigins: allowed,
					directory: () => fetchDirectory(chan.rawClient)
				});
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
			const scheduleCardUpdate = (slot) => {
				if (!slot.streamController) return;
				if (slot.cardUpdateTimer) {
					slot.cardDirty = true;
					return;
				}
				const fire = () => {
					slot.cardUpdateTimer = null;
					slot.lastCardUpdateAt = Date.now();
					updateRunCard(slot, plain.thinkingPolicy).catch((e) => ctx.logger?.warn?.("[connect-lark] card update failed: " + e.message)).finally(() => {
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
						if (!plain.attachSessionId) throw new Error("[connect-lark] attach-gui requires attachSessionId");
						const agent = ctx.agents.get(plain.attachSessionId);
						if (!agent) throw new Error("[connect-lark] attachSessionId not found in agent registry");
						return {
							agent,
							sessionId: plain.attachSessionId,
							handle: null
						};
					}
					const cwd = currentCwd(chatId);
					const expectedSessionId = chatState(chatId).sessionId || deterministicSessionId(chatId, cwd);
					await ensureFirstClass(ctx, expectedSessionId, cwd, title);
					const present = async (sessionId) => {
						if (existing?.titleSet) return;
						try {
							if (title) await ctx.sessionController.rename({
								sessionId,
								title
							});
							if (existing) existing.titleSet = true;
						} catch (error) {
							ctx.logger?.warn?.("[connect-lark] session presentation failed: " + error.message);
						}
					};
					if (existing?.agent && existing.sessionId === expectedSessionId) {
						registerMediaTool(existing.agent, chatId, existing.sessionId);
						await present(existing.sessionId);
						return {
							agent: existing.agent,
							sessionId: existing.sessionId,
							handle: existing.handle
						};
					}
					if (existing?.handle) {
						try {
							await Promise.resolve(existing.handle.dispose());
						} catch {}
						existing.handle = null;
						existing.agent = null;
						existing.sessionId = "";
					}
					const catalog = await ctx.sessionController.modelCatalog();
					const agentOptions = resolveAgentModelOptions(plain, catalog);
					const { agent, sessionId: resolvedSessionId, handle } = await createOrResumeAgent(ctx, expectedSessionId, { cwd }, agentOptions, plain.permissionPreset);
					await present(resolvedSessionId);
					registerMediaTool(agent, chatId, resolvedSessionId);
					return {
						agent,
						sessionId: resolvedSessionId,
						handle
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
						else if (frame?.type === "chunk" && frame.chunk?.type === "tool-call-delta") onDelta("", "tool");
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
					slot.cardHeartbeat = setInterval(() => {
						if (slot.streamController) scheduleCardUpdate(slot);
					}, 3e3);
					slot.cardHeartbeat.unref?.();
					slot.streamReady = new Promise((resolve) => {
						slot.streamReadyResolve = resolve;
					});
					const thisTurn = slot.turnId;
					slot.streamPromise = chan.stream(slot.chatId, { card: {
						initial: richCard({
							title: "DSH 回复",
							color: "blue",
							lines: ["正在思考…"],
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
						if (slot.cardUpdateTimer) {
							clearTimeout(slot.cardUpdateTimer);
							slot.cardUpdateTimer = null;
						}
						slot.cardDirty = false;
						if (!slot.streamController && !slot.streamFailed) {
							if (!(await withTimeout(slot.streamReady ?? Promise.resolve(), streamReadyTimeoutMs())).ok) slot.streamFailed = /* @__PURE__ */ new Error("stream producer did not start within " + streamReadyTimeoutMs() + "ms");
						}
						if (slot.streamFailed || !slot.streamController) {
							const reply = slot.accumulatedText || (slot.failedWith ? friendlyRunFailure(slot.failedWith) : "[connect-lark] 回复未生成");
							await sendBounded(chan, slot.chatId, reply);
							return;
						}
						await refreshSettingsData();
						const panelArgs = plain.agentOwnership === "owned-per-chat" ? settingsCardArgs(slot.chatId) : void 0;
						const effortList = panelArgs ? effortOptionsFor(panelArgs) : void 0;
						const footer = {
							statusLine: settingsStatusLine(buildDisplay(slot.chatId), plain.agentOwnership === "attach-gui"),
							panelArgs: panelArgs ? {
								...panelArgs,
								effortList
							} : void 0,
							onBuilt: plain.agentOwnership === "owned-per-chat" ? (card) => {
								if (lastReplyCards.size > 200) {
									const oldest = lastReplyCards.keys().next().value;
									if (oldest !== void 0) lastReplyCards.delete(oldest);
								}
								lastReplyCards.set(slot.chatId, card);
							} : void 0
						};
						try {
							await finalizeRunCard(slot, plain.thinkingPolicy, footer);
						} catch (e) {
							const reply = slot.accumulatedText || (slot.failedWith ? friendlyRunFailure(slot.failedWith) : "[connect-lark] 回复未生成");
							await sendBounded(chan, slot.chatId, reply);
						}
					} finally {
						if (slot.cardHeartbeat) {
							clearInterval(slot.cardHeartbeat);
							slot.cardHeartbeat = null;
						}
						slot.streamDone?.();
					}
				}
			});
			unsubMessage = chan.on("message", async (msg) => {
				if (!currentAlive()) return;
				if (!passesWhitelist(plain, msg.chatId, msg.senderId, msg.chatType, managerOpenId)) return;
				if (chatTypeCache.size > 2e3) chatTypeCache.clear();
				chatTypeCache.set(msg.chatId, msg.chatType);
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (!text) return;
				if (plain.agentOwnership === "owned-per-chat" && (text.trim() === "确认" || text.trim().toLowerCase() === "confirm")) {
					const pending = pendingConfirms.get(msg.chatId);
					if (pending && pending.openId === msg.senderId && pending.expiresAt > Date.now()) {
						pendingConfirms.delete(msg.chatId);
						await applyDimension(chan, msg.chatId, "permission", { permissionPreset: pending.permission });
						const permName = (settingsData?.permissions ?? []).find((p) => p.value === pending.permission)?.name ?? pending.permission;
						Promise.resolve(chan.send(msg.chatId, { markdown: "✅ 已应用权限：" + (permName || "跟随 DSH 默认") })).catch((e) => ctx.logger?.warn?.("[connect-lark] confirm reply failed: " + e.message));
					} else Promise.resolve(chan.send(msg.chatId, { markdown: "没有待确认的设置，或你不是发起人。" })).catch(() => {});
					return;
				}
				let content = [{
					type: "text",
					text
				}];
				const images = extractImages(msg);
				if (images.length > 0) {
					let gateProvider = plain.provider ?? "";
					let gateModel = plain.model ?? "";
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
			const cardActionHandler = async (evt) => {
				if (!currentAlive()) return;
				const chatId = evt.chatId;
				const openId = evt.operator?.openId ?? "";
				if (!passesWhitelist(plain, chatId, openId, chatTypeCache.get(chatId) ?? "group", managerOpenId)) return { toast: {
					type: "error",
					content: "无权操作设置"
				} };
				const option = evt.action?.option;
				const rawActionValue = evt.action?.value;
				const behaviorName = typeof rawActionValue === "object" && rawActionValue !== null ? rawActionValue.value : rawActionValue;
				const actionName = evt.action?.name;
				const controlName = typeof actionName === "string" && actionName ? actionName : typeof behaviorName === "string" && behaviorName ? behaviorName : void 0;
				if (controlName === "conversation") {
					if (typeof option !== "string" || option === "") return;
					if (!dedupClaim(evt.messageId + ":" + controlName + ":" + option)) return;
					if (option === "__new_conversation__") {
						const targetId = chatState(chatId).sessionId ?? deterministicSessionId(chatId, currentCwd(chatId));
						const row = (settingsData?.sessions ?? []).find((s) => s.sessionId === targetId);
						if (row ? row.blank === true : false) return { toast: {
							type: "success",
							content: "当前已是新对话（空会话），无需切换"
						} };
						let newId;
						try {
							const created = await ctx.sessionController.create({ cwd: currentCwd(chatId) });
							newId = created?.sessionId ?? created?.value?.sessionId;
							if (newId) try {
								const ws = await ctx.workspaceRegistry?.resolveByPath?.(currentCwd(chatId));
								if (ws) await ws.attachSession(newId);
							} catch {}
						} catch (e2) {
							dedupTable.delete(evt.messageId + ":" + controlName + ":" + option);
							return { toast: {
								type: "error",
								content: "新会话创建失败：" + e2.message + "（请重试）"
							} };
						}
						if (!newId) {
							dedupTable.delete(evt.messageId + ":" + controlName + ":" + option);
							return { toast: {
								type: "error",
								content: "新会话创建失败，请重试"
							} };
						}
						touchState(chatId, {
							sessionId: newId,
							cwd: currentCwd(chatId)
						});
						try {
							await ctx.sessionController.rename({
								sessionId: newId,
								title: "新对话"
							});
						} catch {}
						Promise.resolve(chan.send(chatId, { card: buildSwitchRecordCard("📢 新建对话", "blue", ["✨ 已开启全新会话 · " + nowStamp(), "之后的对话在新会话进行，不继承之前的历史"]) })).catch(() => {});
						let rebuilt;
						try {
							rebuilt = rebuildReplyCard(chatId);
						} catch (e2) {
							ctx.logger?.warn?.("[connect-lark] reply card rebuild failed: " + e2.message);
						}
						return rebuilt ? { card: {
							type: "raw",
							data: rebuilt
						} } : void 0;
					}
					const current = chatState(chatId).sessionId || deterministicSessionId(chatId, currentCwd(chatId));
					if (option === current) return { toast: {
						type: "success",
						content: "已是当前对话"
					} };
					const known = (settingsData?.sessions ?? []).find((s) => s.sessionId === option);
					if (!known || known.cwd !== currentCwd(chatId)) return { toast: {
						type: "error",
						content: "该会话不存在或不在当前工作区"
					} };
					const fromTitle = sessionDisplayName(current);
					const toTitle = known.title || option.replace(/^session-/, "").slice(0, 13) + "…";
					touchState(chatId, {
						sessionId: option,
						cwd: known.cwd
					});
					Promise.resolve(chan.send(chatId, { card: buildSwitchRecordCard("📢 切换对话", "violet", ["从 **" + fromTitle + "** 切换至 **" + toTitle + "** · " + nowStamp(), "下一条消息起在新会话继续，历史与设置保留"]) })).catch(() => {});
					let rebuilt;
					try {
						rebuilt = rebuildReplyCard(chatId);
					} catch (e2) {
						ctx.logger?.warn?.("[connect-lark] reply card rebuild failed: " + e2.message);
					}
					return rebuilt ? { card: {
						type: "raw",
						data: rebuilt
					} } : void 0;
				}
				if (controlName === "workspace" || controlName === "model" || controlName === "effort" || controlName === "permission") {
					if (typeof option !== "string" || option === "") return;
					if (!dedupClaim(evt.messageId + ":" + controlName + ":" + option)) return;
					const prevDisplay = buildDisplay(chatId);
					const result = applySelect(chatId, controlName, option, openId);
					if (result.error) return { toast: {
						type: "error",
						content: result.error
					} };
					if (result.switchedWorkspace) {}
					if (result.pendingHigh) return { toast: {
						type: "warning",
						content: "已选择高权限档，回复「确认」以应用（仅发起人，30s 内）"
					} };
					if (!result.partial) return;
					if (controlName === "effort" && result.partial.reasoningEffort) {
						const allowed = effortOptionsFor(settingsCardArgs(chatId, {
							provider: result.partial.provider ?? plain.provider,
							model: result.partial.model ?? plain.model,
							reasoningEffort: result.partial.reasoningEffort
						})).map((o) => o.value);
						if (allowed.length > 1 && !allowed.includes(result.partial.reasoningEffort)) return { toast: {
							type: "error",
							content: "当前模型不支持该思考强度，请先切换模型"
						} };
					}
					applyDimension(chan, chatId, controlName, result.partial, evt.messageId + ":" + controlName + ":" + option);
					if (controlName === "workspace") return;
					const dimLabels = {
						workspace: "工作区",
						model: "模型",
						effort: "思考强度",
						permission: "权限"
					};
					const field = controlName;
					const prevLabel = prevDisplay?.[field] ?? "跟随 DSH 默认";
					const switchToast = {
						type: "success",
						content: prevLabel === nextLabelOf(field, result.partial) ? "✅ 已设置（已保存到插件配置，Web 设置页同步可见）" : "✅ " + dimLabels[controlName] + "已切换：" + prevLabel + " → " + nextLabelOf(field, result.partial) + "（已保存到插件配置，Web 设置页同步可见）"
					};
					let panel;
					if (controlName === "model" && result.partial.provider && result.partial.model) panel = rebuildReplyCard(chatId, {
						provider: result.partial.provider,
						model: result.partial.model,
						reasoningEffort: ""
					});
					else try {
						rebuildReplyCard(chatId);
					} catch (e) {
						ctx.logger?.warn?.("[connect-lark] reply card rebuild failed: " + e.message);
					}
					return panel ? {
						toast: switchToast,
						card: {
							type: "raw",
							data: panel
						}
					} : { toast: switchToast };
				}
				const rawValue = evt.action?.value;
				const kind = typeof rawValue === "object" && rawValue !== null ? rawValue.value : rawValue;
				if (typeof kind !== "string" || kind.length === 0) return;
				if (!dedupClaim(evt.messageId + ":" + kind)) return;
				if (kind === "cancel-settings") return { toast: {
					type: "info",
					content: "已关闭"
				} };
				if (kind.startsWith("approve:") || kind.startsWith("reject:")) {
					const callId = kind.slice(kind.indexOf(":") + 1);
					const pending = pendingApprovals.get(callId);
					if (!pending) return { toast: {
						type: "error",
						content: "审批已失效或已处理"
					} };
					pendingApprovals.delete(callId);
					const outcome = kind.startsWith("approve:") ? "allowed-once" : "rejected";
					pending.resolve(outcome);
					if (pending.messageId) Promise.resolve(chan.updateCard(pending.messageId, buildApprovalFinalCard(pending.toolName, outcome))).catch((e) => ctx.logger?.warn?.("[connect-lark] approval card final update failed: " + e.message));
					return { toast: {
						type: "success",
						content: outcome === "allowed-once" ? "✅ 已同意" : "⛔ 已拒绝"
					} };
				}
				return { toast: {
					type: "info",
					content: "该按钮来自旧版卡片，请展开最新回复卡操作"
				} };
			};
			unsubCardAction = chan.on("cardAction", cardActionHandler);
			refreshSettingsData().catch(() => {});
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
			if (unsubCardAction) try {
				unsubCardAction();
			} catch {}
			unsubCardAction = null;
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
			sessionChat.clear();
			mediaRegistered.clear();
			for (const [, p] of pendingApprovals) try {
				p.resolve("cancelled");
			} catch {}
			pendingApprovals.clear();
		};
		const queueBoot = () => {
			transition = transition.then(async () => {
				await cleanup();
				if (!dead) await boot();
			}).catch((e) => {
				ctx.logger?.error?.("[connect-lark] boot failed: " + e.message);
			});
		};
		const unsubVolatile = ctx.on("loader/volatile-update", (paths) => {
			const fields = new Set((paths ?? []).map((p) => Array.isArray(p) ? p[p.length - 1] : String(p)));
			const RECONNECT_FIELDS = /* @__PURE__ */ new Set([
				"enabled",
				"appId",
				"appSecretRef",
				"domain",
				"agentOwnership",
				"attachSessionId",
				"requireMention"
			]);
			if ([...fields].some((f) => RECONNECT_FIELDS.has(f))) {
				queueBoot();
				return;
			}
			plain = plainConfig(config);
			ctx.logger?.info?.("[connect-lark] hot config update (no reconnect): " + [...fields].join(", "));
		});
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
	ctx.on("approval/request", (req, next) => {
		const sid = req?.agent?.session?.id;
		const chatId = sessionChat.get(sid);
		if (!chatId) return next();
		if (!channel) return Promise.resolve("cancelled");
		const callId = req?.callId || "anon-" + ++approvalSeq;
		return new Promise((resolve) => {
			const now = Date.now();
			for (const [cid, p] of pendingApprovals) if (p.expiresAt <= now) pendingApprovals.delete(cid);
			pendingApprovals.set(callId, {
				resolve,
				chatId,
				messageId: "",
				toolName: req?.toolName ?? "",
				expiresAt: now + APPROVAL_TTL_MS
			});
			(async () => {
				try {
					const sent = await withTimeout(channel.send(chatId, { card: buildApprovalCard(req?.toolName ?? "", req?.reason ?? req?.displayReason?.en, callId) }), 15e3);
					if (sent.ok) {
						const mid = sent.value?.messageId;
						const pending = pendingApprovals.get(callId);
						if (pending) pending.messageId = mid ?? "";
					} else {
						const pending = pendingApprovals.get(callId);
						if (pending) {
							pendingApprovals.delete(callId);
							pending.resolve("cancelled");
						}
					}
				} catch (e) {
					ctx.logger?.warn?.("[connect-lark] approval card send failed: " + e.message);
					const pending = pendingApprovals.get(callId);
					if (pending) {
						pendingApprovals.delete(callId);
						pending.resolve("cancelled");
					}
				}
			})();
			setTimeout(() => {
				const pending = pendingApprovals.get(callId);
				if (pending) {
					pendingApprovals.delete(callId);
					pending.resolve("cancelled");
				}
			}, APPROVAL_TTL_MS).unref?.();
		});
	}, { prepend: true });
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
	streaming: "channel.stream(to, { markdown: async (c) => { c.append(delta) } }) — SDK-owned CardKit"
};
export { CANCEL_SETTINGS_VALUE, CONTRACT_NOTES, Config, DEFAULT_OPTION_VALUE, DIRECTORY_PORT, FEISHU_CDN_HOSTS, IMAGE_UNSUPPORTED_REPLY, MAX_IMAGE_BYTES, RunManager, admitImage, apply, buildApprovalCard, buildApprovalFinalCard, buildImageContent, buildSettingsPanel, buildUserMessage, createOrResumeAgent, currentModelValue, cwdTag, defaultStatePath, downloadImageBounded, downloadInboundImage, effortOptions, fetchDirectoryUsers, inject, listDirectoryUsers, loadStates, modelOptions, passesWhitelist, plainConfig, resolveAgentModelOptions, resolveAppSecret, richCard, saveStates, settingsStatusLine, startDirectoryService, streamMarkdown };
