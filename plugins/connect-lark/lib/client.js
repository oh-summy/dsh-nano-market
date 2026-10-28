window.__ModuleLoader__.load({
	id: "@oh-summy/connect-lark",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		// Native settings page for @oh-summy/connect-lark.
// DSH serves Config schemas on the Host, but third-party bundles appear on the
// Plugins page only after a browser module registers plugins.bundle.config.
const { jsx, jsxs } = require("react/jsx-runtime");
const P = require("@deepseek-ai/dsh-client-ui-primitives");

const NS = "connect-lark.settings";
const PACKAGE = "@oh-summy/connect-lark";
const ENTRY = "connect-lark";
const inject = ["slots", "locale", "configForms"];

const zh = {
  title: "飞书 / Lark",
  description: "配置飞书长连接、Agent 驱动和消息访问控制。",
  connection: "连接",
  agent: "Agent 驱动",
  messages: "消息与访问控制",
  advanced: "高级",
  enabled: "启用飞书连接",
  enabledHint: "关闭后不建立长连接；修改后保存生效。",
  appId: "App ID",
  appIdHint: "飞书开放平台自建应用的 App ID。",
  appSecretRef: "App Secret 凭据引用",
  appSecretRefHint: "凭据缝中的引用名，不在此填写或保存明文 Secret。",
  domain: "服务域",
  domainHint: "国内飞书选择 feishu；国际版 Lark 选择 lark。",
  requireMention: "群聊需要 @ 机器人",
  requireMentionHint: "关闭后群里的所有消息都可能触发，请同时配置白名单。",
  agentOwnership: "Agent 所有权",
  agentOwnershipHint: "attach-gui 复用宿主 Agent；owned-per-chat 为每个会话创建独立 Agent。",
  attachSessionId: "目标 Session ID",
  attachSessionIdHint: "attach-gui 模式必填；owned-per-chat 模式无需填写。",
  provider: "Provider",
  providerHint: "owned-per-chat 模式必填；attach-gui 可留空。",
  model: "Model",
  modelHint: "owned-per-chat 模式必填；attach-gui 可留空。",
  defaultPath: "默认工作目录",
  defaultPathHint: "留空使用宿主当前工作目录；owned-per-chat 建议使用绝对路径。",
  openId: "你的 Open ID",
  openIdHint: "用于私聊和联调测试，可选。",
  senderAllowlist: "Sender 白名单",
  senderAllowlistHint: "每行或逗号分隔一个 open_id；两个白名单都必须非空才会放行。",
  groupAllowlist: "群聊白名单",
  groupAllowlistHint: "每行或逗号分隔一个 chat_id；私聊也需要对应 chat_id 才能放行。",
  thinkingPolicy: "思考过程策略",
  thinkingPolicyHint: "当前实现使用 stream-only，不展示模型思考过程。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "配置未被接受，请检查字段后重试。",
  readOnly: "当前部署的配置为只读。",
  unavailable: "connect-lark 未运行，暂时无法配置。",
  overridden: "已覆盖",
  reset: "恢复默认",
};

const en = { ...zh };

const FIELDS = [
  { path: "enabled", label: "enabled", kind: "boolean", section: "connection" },
  { path: "appId", label: "appId", kind: "text", section: "connection" },
  { path: "appSecretRef", label: "appSecretRef", kind: "text", section: "connection" },
  { path: "domain", label: "domain", kind: "choice", section: "connection", choices: ["feishu", "lark"] },
  { path: "requireMention", label: "requireMention", kind: "boolean", section: "connection" },
  { path: "agentOwnership", label: "agentOwnership", kind: "choice", section: "agent", choices: ["attach-gui", "owned-per-chat"] },
  { path: "attachSessionId", label: "attachSessionId", kind: "text", section: "agent" },
  { path: "provider", label: "provider", kind: "text", section: "agent" },
  { path: "model", label: "model", kind: "text", section: "agent" },
  { path: "defaultPath", label: "defaultPath", kind: "text", section: "agent" },
  { path: "openId", label: "openId", kind: "text", section: "messages" },
  { path: "senderAllowlist", label: "senderAllowlist", kind: "list", section: "messages" },
  { path: "groupAllowlist", label: "groupAllowlist", kind: "list", section: "messages" },
  { path: "thinkingPolicy", label: "thinkingPolicy", kind: "choice", section: "advanced", choices: ["stream-only", "cot-visible", "cot-discard"] },
];

function parseList(text) {
  return [...new Set(text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function definition(field) {
  const base = P.settingsTextField(field.path);
  const result = {
    ...base,
    parse(text) {
      if (field.kind === "boolean") return { kind: "set", value: text === "true" };
      if (field.kind === "list") return { kind: "set", value: parseList(text) };
      if (field.kind === "choice") {
        return field.choices.includes(text) ? { kind: "set", value: text } : undefined;
      }
      const value = text.trim();
      return value === "" ? { kind: "clear" } : { kind: "set", value };
    },
  };
  if (field.kind === "boolean") result.format = (value) => value === true ? "true" : "false";
  if (field.kind === "list") result.format = (value) => Array.isArray(value) ? value.join("\n") : "";
  return result;
}

class LarkSettingsModel {
  constructor(scope) {
    this.form = new P.SettingsFormModel(scope, FIELDS.map(definition));
    this.state = this.form.bind(() => ({
      ...this.form.shell(),
      fields: Object.fromEntries(FIELDS.map((field) => [field.path, this.form.field(field.path)])),
    }));
  }
  inject() {
    return { hooks: { larkSettings: this.state }, ...this.form.actions() };
  }
  dispose() {
    this.form.dispose();
  }
}

const controlStyle = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #d7dce3",
  borderRadius: 8,
  background: "#fff",
  color: "#15181d",
  padding: "9px 11px",
  font: "inherit",
};
const hintStyle = { color: "#6b7280", fontSize: 12, lineHeight: 1.55, margin: "6px 0 0" };
const labelStyle = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 7 };

function TextControl({ field, value, disabled, edit, reset, t }) {
  return jsx(P.SettingsValueField, {
    id: "connect-lark-" + field.path,
    label: t(field.label),
    hint: t(field.path + "Hint"),
    overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    disabled,
    ...value,
    onEdit: edit,
    onReset: reset,
  });
}

function ChoiceControl({ field, value, disabled, edit, t }) {
  return jsxs("div", {
    style: { marginBottom: 18 },
    children: [
      jsx("label", { htmlFor: "connect-lark-" + field.path, style: labelStyle, children: t(field.label) }),
      jsx("select", {
        id: "connect-lark-" + field.path,
        style: controlStyle,
        value: value.text,
        disabled,
        onChange: (event) => edit(event.target.value),
        children: field.choices.map((choice) => jsx("option", { value: choice, children: choice }, choice)),
      }),
      jsx("p", { style: hintStyle, children: t(field.path + "Hint") }),
    ],
  });
}

function BooleanControl({ field, value, disabled, edit, t }) {
  return jsxs("div", {
    style: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 },
    children: [
      jsx("input", {
        id: "connect-lark-" + field.path,
        type: "checkbox",
        role: "switch",
        checked: value.text === "true",
        disabled,
        onChange: (event) => edit(event.target.checked ? "true" : "false"),
        style: { width: 18, height: 18, marginTop: 2, flexShrink: 0 },
      }),
      jsxs("div", {
        children: [
          jsx("label", { htmlFor: "connect-lark-" + field.path, style: { ...labelStyle, marginBottom: 0 }, children: t(field.label) }),
          jsx("p", { style: hintStyle, children: t(field.path + "Hint") }),
        ],
      }),
    ],
  });
}

function Section({ title, children }) {
  return jsxs("section", {
    style: { borderTop: "1px solid #e8ebef", paddingTop: 18, marginTop: 22 },
    children: [
      jsx("h4", { style: { margin: "0 0 16px", fontSize: 14, fontWeight: 650 }, children: title }),
      children,
    ],
  });
}

function LarkConfigCard(props) {
  const state = props.useLarkSettings((snapshot) => snapshot);
  const t = props.t;
  const disabled = !state.writable;
  const renderField = (field) => {
    const value = state.fields[field.path];
    const edit = (text) => props.edit(field.path, text);
    if (field.kind === "boolean") return jsx(BooleanControl, { field, value, disabled, edit, t }, field.path);
    if (field.kind === "choice") return jsx(ChoiceControl, { field, value, disabled, edit, t }, field.path);
    return jsx(TextControl, {
      field, value, disabled, edit, t,
      reset: () => props.resetField(field.path),
    }, field.path);
  };
  const section = (id) => jsx(Section, {
    title: t(id),
    children: FIELDS.filter((field) => field.section === id).map(renderField),
  }, id);
  return jsxs("div", {
    children: [
      jsx("p", { style: { ...hintStyle, margin: "0 0 8px" }, children: t("description") }),
      jsx(P.SettingsForm, {
        labels: {
          unavailable: t("unavailable"),
          readOnly: t("readOnly"),
          saveFailed: t("saveFailed"),
          save: t("save"),
          saving: t("saving"),
        },
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [section("connection"), section("agent"), section("messages"), section("advanced")],
      }),
    ],
  });
}

function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "connect-lark: dictionaries");
  const model = new LarkSettingsModel(ctx.configForms.get(ENTRY));
  ctx.effect(() => () => model.dispose(), "connect-lark: form subscription");
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject(
    "plugins.bundle.config",
    () => ctx.slots.register({
      name: "plugins.bundle.config",
      key: PACKAGE,
      locale: NS,
      inject: () => model.inject(),
    }, LarkConfigCard),
  )), "connect-lark: settings page");
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
