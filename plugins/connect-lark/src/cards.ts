// @oh-summy/connect-lark — CardKit building helpers.
//
// Two outbound paths (ARCHITECTURE §3.2):
//   1) Plain markdown streaming -> channel.stream(to, { markdown }) — SDK-owned CardKit
//   2) Rich cards (title color / footer / buttons) -> caller supplies raw CardKit JSON
//
// This module provides (2): a fixed layout helper + a stream-markdown wrapper,
// plus the Issue #17 settings surfaces: the reply-card status line and the
// settings card (select_static "select-and-apply" style — each choice takes
// effect immediately for the next turn, no form-submit dependency).
//
// CardKit 2.0 component usage is deliberately conservative: only elements the
// plugin already ships (div/lark_md, hr, button/callback, collapsible_panel)
// plus select_static, whose option-callback shape the channel SDK exposes
// (CardActionEvent.action.option). A form-based "apply once" variant remains a
// follow-up if the S0 real-device probe confirms select limits.

/** CardKit JSON 2.0 color tokens for header.template. */
export type CardColor = "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey";

export interface RichCardOptions {
  title: string;
  /** 卡片副标题（header.subtitle，官方字段）：用于 Issue #17 的会话级配置状态行，
   *  与正文彻底分离，一眼可见。 */
  headerSubtitle?: string;
  color: CardColor;
  /** 运行状态行（渲染为首元素）：如「⏳ 正在生成中 · 已用时 3s」/「✅ 已完成」。 */
  status?: string;
  /** Markdown lines. "---" renders as a horizontal rule. */
  lines: string[];
  /** Collapsible panels appended after the lines (CardKit 2.0 折叠面板). */
  panels?: Array<{ title: string; content: string; expanded?: boolean }>;
  /** Footer small text (the "bottom note"). */
  note?: string;
  /** Optional button(s). Each gets a url or a callback value. */
  buttons?: Array<{ text: string; url?: string; value?: string }>;
  /** Raw CardKit 2.0 elements appended after the markdown lines (e.g. the
   *  Issue #17 inline settings panel). Rendered before buttons and note. */
  appendElements?: Array<Record<string, unknown>>;
}

/**
 * CardKit 2.0 折叠面板：默认收起，点标题展开。用于「思考过程」——
 * 只保留实测被飞书接受的属性（2.0 拒绝 border.style/background_style 等 1.0 字段）。
 */
function collapsiblePanel(panel: { title: string; content: string; expanded?: boolean }): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: panel.expanded === true,
    header: {
      title: { tag: "plain_text", content: panel.title },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small_outlined" },
      icon_position: "follow",
    },
    elements: [{ tag: "div", text: { tag: "lark_md", content: panel.content } }],
  };
}

/**
 * Build a CardKit JSON 2.0 object with header + body elements.
 *
 * This is the "raw CardKit JSON" path — the SDK does NOT own this structure.
 * The caller must provide it (ARCHITECTURE §3.2).
 */
export function richCard(opts: RichCardOptions): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  // 状态行渲染在最前：生成中/已完成一目了然
  if (opts.status) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: opts.status } });
  }
  // 折叠面板渲染在正文之前：思考过程先出现，完成后折叠，正文在其下
  if (opts.panels) {
    for (const p of opts.panels) elements.push(collapsiblePanel(p));
  }
  for (const line of opts.lines) {
    if (line === "---") elements.push({ tag: "hr" });
    else elements.push({ tag: "div", text: { tag: "lark_md", content: line } });
  }
  if (opts.appendElements) {
    for (const el of opts.appendElements) elements.push(el);
  }
  if (opts.buttons && opts.buttons.length > 0) {
    // CardKit 2.0: buttons are direct elements, not an action wrapper.
    for (const b of opts.buttons) {
      const behaviors: Array<Record<string, unknown>> = [];
      if (b.url) behaviors.push({ type: "open_url", default_url: b.url });
      if (b.value) behaviors.push({ type: "callback", value: { value: b.value } });
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: b.text },
        type: "primary",
        size: "small",
        behaviors,
      });
    }
  }
  if (opts.note) {
    // CardKit 2.0 does not accept the legacy note tag. Use a plain-text
    // div for the small footer instead.
    elements.push({ tag: "div", text: { tag: "plain_text", content: opts.note } });
  }
  const header: Record<string, unknown> = {
    title: { tag: "plain_text", content: opts.title },
    template: opts.color,
  };
  if (opts.headerSubtitle) {
    header.subtitle = { tag: "plain_text", content: opts.headerSubtitle };
  }
  return {
    schema: "2.0",
    header,
    body: { elements },
  };
}

/**
 * Internal helper: stream plain markdown via channel.stream().
 * Not used by the production reply path (which uses rich cards).
 */
export async function streamMarkdown(
  channel: { stream: (to: string, input: { markdown: (c: { append: (s: string) => void }) => Promise<void> }) => Promise<unknown> },
  to: string,
  getDelta: () => Promise<string | null>,
): Promise<unknown> {
  return channel.stream(to, {
    markdown: async (c) => {
      while (true) {
        const delta = await getDelta();
        if (delta === null) break;
        if (delta.length > 0) c.append(delta);
      }
    },
  });
}

// ---- Issue #17 settings surfaces ------------------------------------------

/** Human-readable current settings for the reply-card status line. */
export interface SettingsDisplay {
  workspace?: string;
  model?: string;
  effort?: string;
  permission?: string;
}

/** One markdown line appended to the finished reply card. */
export function settingsStatusLine(display: SettingsDisplay | undefined, attachGui: boolean): string {
  if (attachGui) return "⚙️ 设置：attach-gui 模式共享 GUI 会话，不可用";
  if (!display) return "⚙️ 模型 / 强度 / 权限 / 工作区：跟随 DSH 默认";
  const parts: string[] = [];
  if (display.workspace) parts.push("工作区 " + display.workspace);
  if (display.model) parts.push("模型 " + display.model);
  if (display.effort) parts.push("强度 " + display.effort);
  if (display.permission) parts.push("权限 " + display.permission);
  return parts.length > 0 ? "⚙️ " + parts.join(" · ") : "⚙️ 跟随 DSH 默认";
}

/** CardAction callback value of the "关闭" button on the settings card. */
export const CANCEL_SETTINGS_VALUE = "cancel-settings";

/** Sentinel option value: clear that dimension back to "follow DSH default". */
export const DEFAULT_OPTION_VALUE = "__default__";

/** 「对话」下拉的哨兵值：开启新对话（解除会话绑定，下一条消息起是新会话）。 */
export const NEW_CONVERSATION_VALUE = "__new_conversation__";

export interface CatalogModelView {
  id: string;
  name?: string;
  reasoning?: { efforts?: ReadonlyArray<{ id: string; name: string }>; defaultEffort?: string };
}
export interface CatalogProviderView {
  id: string;
  name?: string;
  models?: ReadonlyArray<CatalogModelView>;
}

export interface SettingsCardOptions {
  catalog: { default?: { provider?: string; model?: string }; groups?: ReadonlyArray<CatalogProviderView> };
  workspaces: ReadonlyArray<{ id: string; title: string }>;
  permissions: ReadonlyArray<{ value: string; name: string }>;
  defaultPermission?: string;
  current?: { workspaceId?: string; provider?: string; model?: string; reasoningEffort?: string; permission?: string };
  /** 思考强度选项直传（调用方已按当前模型算好）；缺省时回退 catalog 清单。
   *  catalog 的档位本身由宿主用 llm.resolveModelInfo 精确路由解析填充，与 Web 选择器同源。 */
  effortList?: ReadonlyArray<{ label: string; value: string }>;
  hasPendingPermission?: boolean;
  defaultWorkspaceTitle?: string;
  /** 「对话」下拉的候选：当前工作区的会话（标题来自宿主首条消息自动命名，无标题的显示 id + 相对时间） */
  chatSessions?: ReadonlyArray<{ sessionId: string; title: string; cwd?: string; updatedAt?: number }>;
  /** 当前绑定的会话 id（对话下拉的 initial_option） */
  currentSessionId?: string;
  /** 会话总数（超出下拉容量时在面板注明） */
  sessionsTotal?: number;
  /** 诊断：标题批量读取的失败原因（空 = 读取正常） */
  titleError?: string;
}

/** Flat options for the model select: value = "provider:model". */
export function modelOptions(catalog: SettingsCardOptions["catalog"]): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      const providerLabel = group.name || group.id;
      const modelLabel = model.name || model.id;
      out.push({ label: providerLabel + " · " + modelLabel, value: group.id + ":" + model.id });
    }
  }
  return out;
}

/** Current model route as a select value ("provider:model") or undefined. */
export function currentModelValue(current: SettingsCardOptions["current"], catalog: SettingsCardOptions["catalog"]): string | undefined {
  if (current?.provider && current?.model) return current.provider + ":" + current.model;
  const def = catalog?.default;
  if (def?.provider && def?.model) return def.provider + ":" + def.model;
  return undefined;
}

/** Effort options for the model the user has (explicit override or default). */
export function effortOptions(currentModelValue: string | undefined, catalog: SettingsCardOptions["catalog"]): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [
    { label: "跟随模型默认", value: DEFAULT_OPTION_VALUE },
  ];
  if (!currentModelValue) return options;
  const sep = currentModelValue.indexOf(":");
  const provider = currentModelValue.slice(0, sep);
  const modelId = currentModelValue.slice(sep + 1);
  const group = (catalog?.groups ?? []).find((g) => g.id === provider);
  const model = group?.models?.find((m) => m.id === modelId);
  for (const effort of model?.reasoning?.efforts ?? []) {
    options.push({ label: effort.name, value: effort.id });
  }
  return options;
}

/** The four select_static elements shared by the combined settings card and
 *  the inline settings panel: workspace / model / effort / permission, with
 *  empty-option placeholders so Feishu never rejects the card. */
function settingsSelectElements(opts: SettingsCardOptions): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];

  // 工作区
  const workspaceOptions: Array<{ label: string; value: string }> = [
    { label: opts.defaultWorkspaceTitle ?? "默认工作区", value: DEFAULT_OPTION_VALUE },
  ];
  for (const w of opts.workspaces) workspaceOptions.push({ label: w.title, value: w.id });
  elements.push(selectStatic("workspace", "工作区", workspaceOptions, opts.current?.workspaceId));

  // 模型（首项固定为「跟随 DSH 默认」——否则飞书在未设 initial_option 时显示第一项，
  // 会把列表首模型误显示成「当前模型」；catalog 失败/无模型时给占位项防空 options 被拒）
  const modelOptionsList: Array<{ label: string; value: string }> = [
    { label: "跟随 DSH 默认", value: DEFAULT_OPTION_VALUE },
    ...modelOptions(opts.catalog),
  ];
  if (modelOptionsList.length === 1) modelOptionsList.push({ label: "暂无可用模型", value: "" });
  elements.push(selectStatic("model", "模型", modelOptionsList, currentModelValue(opts.current, opts.catalog)));

  // 思考强度（随当前模型联动；优先调用方算好的 effortList）
  const effortList = opts.effortList ?? effortOptions(currentModelValue(opts.current, opts.catalog), opts.catalog);
  elements.push(selectStatic("effort", "思考强度", effortList, opts.current?.reasoningEffort));

  // 权限（permissionPresets.catalog 失败/无预设时给占位项，防空 options 被飞书拒绝整卡）
  const permissionOptions: Array<{ label: string; value: string }> = [];
  for (const p of opts.permissions) permissionOptions.push({ label: p.name, value: p.value });
  if (opts.defaultPermission) {
    permissionOptions.push({ label: "设为 DSH 默认预设", value: DEFAULT_OPTION_VALUE });
  }
  if (permissionOptions.length === 0) permissionOptions.push({ label: "跟随 DSH 默认", value: DEFAULT_OPTION_VALUE });
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
function settingsRow(items: Array<{ label: string; color: string; select: Record<string, unknown> }>): Record<string, unknown> {
  const columns = items.map((it) => [
    // 标签列固定宽 + 标签居中：两字/三字标签的两侧空隙对称，组内贴合度一致（真机反馈 2026-11-18）
    { tag: "column", width: "auto", horizontal_align: "right", vertical_align: "center",
      elements: [{ tag: "markdown", content: "<text_tag color='" + it.color + "'>" + it.label + "</text_tag>" }] },
    { tag: "column", width: "weighted", weight: 1, vertical_align: "center", horizontal_spacing: "small", elements: [it.select] },
  ]).flat();
  return { tag: "column_set", flex_mode: "none", columns };
}

/** 系统提醒卡（轻量）：换对话/新建对话的记录条目——不同维度不同头部色，
 *  与正常回复卡（绿）区分（负责人 2026-11-18：系统提醒卡片头部颜色应不一样）。 */
export function buildSwitchRecordCard(
  headerTitle: string,
  template: "blue" | "violet" | "turquoise",
  markdownLines: string[],
  opts?: { conversationSelect?: { options: Array<{ label: string; value: string }>; initial?: string } },
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = markdownLines.map((line) => ({ tag: "markdown", content: line }));
  if (opts?.conversationSelect) {
    elements.push({
      tag: "select_static", name: "conversation",
      placeholder: { tag: "plain_text", content: "切换对话" },
      options: opts.conversationSelect.options.map((o) => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
      behaviors: [{ type: "callback", value: { value: "conversation" } }],
      ...(opts.conversationSelect.initial ? { initial_option: opts.conversationSelect.initial } : {}),
    });
  }
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: headerTitle }, template },
    body: { elements },
  };
}

/** 工作区切换卡：横幅 + 新工作区的「对话」下拉——切换后直接在这条消息里
 *  选历史会话接回（负责人 2026-11-18：每个工作区与会话完全绑定）。 */
export function buildWorkspaceSwitchCard(
  fromTitle: string,
  toTitle: string,
  sessions: ReadonlyArray<{ sessionId: string; title: string; updatedAt?: number }>,
): Record<string, unknown> {
  const options: Array<{ label: string; value: string }> = [
    { label: "✨ 使用新对话（默认）", value: NEW_CONVERSATION_VALUE },
  ];
  for (const s of sessions.slice(0, 12)) {
    const name = s.title || s.sessionId.replace(/^session-/, "").slice(0, 8) + "…";
    const rel = relativeTime(s.updatedAt ?? 0);
    options.push({ label: name + " · " + rel, value: s.sessionId });
  }
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "📢 已切换工作区" }, template: "turquoise" },
    body: { elements: [
      { tag: "markdown", content: "从 **" + fromTitle + "** 切换至 **" + toTitle + "** · 已开启新对话（不继承历史）" },
      { tag: "markdown", content: "<font color='grey'>如需继续之前的对话，直接在下拉选择（历史与设置保留）：</font>" },
      { tag: "select_static", name: "conversation",
        placeholder: { tag: "plain_text", content: "切换对话" },
        options: options.map((o) => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
        behaviors: [{ type: "callback", value: { value: "conversation" } }] },
    ] },
  };
}

/** 相对时间（跟 DSH 会话列表同口径）：10 分钟 / 10 小时 / 3 天 / 2 个月 / 1 年。 */
export function relativeTime(updatedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const minutes = Math.floor(diff / 60_000);
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
function conversationSelect(opts: SettingsCardOptions): Record<string, unknown> {
  const options: Array<{ label: string; value: string }> = [
    { label: "✨ 开启新对话", value: NEW_CONVERSATION_VALUE },
  ];
  const seen = new Set<string>([NEW_CONVERSATION_VALUE]);
  for (const s of opts.chatSessions ?? []) {
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    const isCurrent = s.sessionId === opts.currentSessionId;
    const name = s.title || s.sessionId.replace(/^session-/, "").slice(0, 13) + "…";
    const rel = relativeTime(s.updatedAt ?? 0);
    options.push({ label: (isCurrent ? "📍 " : "") + name + " · " + rel, value: s.sessionId });
  }
  // initial：当前绑定会话在候选里就指向它；否则指向「新对话」（无绑定 = 默认会话尚未出现在清单）
  const initial = opts.currentSessionId && seen.has(opts.currentSessionId) ? opts.currentSessionId : undefined;
  const el = selectStatic("conversation", "切换对话", options, initial ?? NEW_CONVERSATION_VALUE);
  return el;
}

export function buildSettingsPanel(opts: SettingsCardOptions): Record<string, unknown> {
  const selects = settingsSelectElements(opts);
  const chatSelect = conversationSelect(opts);
  const elements: Array<Record<string, unknown>> = [
    // 引导行：说明语义 + 会话总数（灰字）
    { tag: "markdown", content: "<font color='grey'>选择后立即保存到插件配置（与 Web 设置页同步）· 切换对话 / 工作区从下一条消息起生效 · 本工作区共 " + (opts.sessionsTotal ?? 0) + " 个会话</font>" },
    // 三行布局（标签与下拉同排）：对话下拉占满整行（露出更多标题文字）；模型+强度；工作区+权限
    settingsRow([{ label: "对话", color: "indigo", select: chatSelect }]),
    settingsRow([
      { label: "模型", color: "blue", select: selects[1] },
      { label: "强度", color: "turquoise", select: selects[2] },
    ]),
    settingsRow([
      { label: "工作区", color: "green", select: selects[0] },
      { label: "权限", color: "orange", select: selects[3] },
    ]),
  ];
  if (opts.hasPendingPermission) {
    elements.push({
      tag: "markdown",
      content: "<font color='red'>⚠️ 高权限档待确认：回复**确认**以应用（仅发起人有效，30s 内）</font>",
    });
  }
  const overflow: Array<Record<string, unknown>> = opts.titleError
    ? [{ tag: "div", text: { tag: "lark_md", content: "（标题读取：" + opts.titleError + "）" } }]
    : [];
  return {
    tag: "collapsible_panel",
    expanded: false,
    vertical_spacing: "8px",
    header: {
      title: { tag: "markdown", content: "⚙️ **会话设置**" },
      background_color: "grey",
      vertical_align: "center",
      padding: "6px 0px 6px 10px",
      icon: { tag: "standard_icon", token: "down-small_outlined" },
      icon_position: "follow",
    },
    elements,
  };
}


/** CardKit 2.0 select_static: the component fires card.action.trigger by
 * default (official doc), with action.name = element name and
 * action.option = the chosen value. behaviors carries the official-recommended
 * custom回传参数 so action.value also names the control (belt and braces;
 * the handler keys off action.name, not action.value). initial_option is a
 * verified CardKit 2.0 field (官方文档：选项展示的初始内容). */
function selectStatic(
  name: string,
  placeholder: string,
  options: ReadonlyArray<{ label: string; value: string }>,
  initial: string | undefined,
): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tag: "select_static",
    name,
    placeholder: { tag: "plain_text", content: placeholder },
    options: options.map((o) => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
    behaviors: [{ type: "callback", value: { value: name } }],
  };
  // initial_option 必须是 options 里的值——指向不存在的值会让飞书拒绝整张卡
  // （独立审查 P2-6：配置里的模型不在 catalog 时就会发生）。
  if (initial && options.some((o) => o.value === initial)) element.initial_option = initial;
  return element;
}

// ---- P5：审批卡（一等公民会话层改造） --------------------------

/** P5 审批卡：工具名 + 原因 + [同意][拒绝] 两个回调按钮。
 *  按钮 value 携带 callId（approve:<callId> / reject:<callId>），回调据此 resolve 对应审批。 */
export function buildApprovalCard(toolName: string, reason?: string, callId?: string): Record<string, unknown> {
  const lines = ["**需要审批**", "**工具**：" + (toolName || "未知"), ...(reason ? ["**原因**：" + reason] : [])];
  return richCard({
    title: "审批请求",
    color: "orange",
    lines,
    buttons: [
      { text: "✅ 同意", value: "approve:" + (callId ?? "") },
      { text: "⛔ 拒绝", value: "reject:" + (callId ?? "") },
    ],
  });
}

/** P5 审批终态卡：就地替换审批卡（同 messageId 全量更新），按钮区换成结论文本，
 *  卡片不消失、不撤回——像用户给 DSH 发了一条决策消息那样留痕。 */
export function buildApprovalFinalCard(toolName: string, outcome: "allowed-once" | "rejected" | "cancelled"): Record<string, unknown> {
  const ok = outcome === "allowed-once";
  const lines = [
    ok ? "✅ **你已同意**：" + (toolName || "该操作") : outcome === "rejected" ? "⛔ **你已拒绝**：" + (toolName || "该操作") : "🚫 **审批已取消**：" + (toolName || "该操作"),
    "（connect-lark 审批记录，留存于本对话）",
  ];
  return richCard({
    title: "审批结果",
    color: ok ? "green" : "red",
    lines,
  });
}
