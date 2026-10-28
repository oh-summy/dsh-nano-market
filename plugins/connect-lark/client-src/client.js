// Native settings page for @oh-summy/connect-lark.
// A short, guided setup: Feishu app -> workspace/model -> trigger policy.
const { jsx, jsxs } = require("react/jsx-runtime");
const P = require("@deepseek-ai/dsh-client-ui-primitives");
const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

const NS = "connect-lark.settings";
const PACKAGE = "@oh-summy/connect-lark";
const ENTRY = "connect-lark";
const inject = ["slots", "locale", "remote", "remote.session", "configForms"];

const zh = {
  heroTitle: "把飞书消息交给 DSH",
  heroDescription: "连接应用后，私聊和群里的消息会进入你选择的 DSH 工作区。",
  heroStatus: "插件开启后自动连接",
  connection: "连接飞书",
  connectionHint: "只需应用信息，国内和海外可以随时切换。",
  workspace: "工作区与模型",
  workspaceHint: "默认沿用 DSH 当前的工作方式，需要时再覆盖。",
  trigger: "触发方式",
  triggerHint: "默认允许所有私聊；群里只在 @ 机器人时响应。",
  feishu: "飞书 · 国内",
  lark: "Lark · 海外",
  appId: "App ID",
  appIdHint: "飞书开放平台里，自建应用的 App ID。",
  appSecretRef: "App Secret 凭据引用",
  appSecretRefHint: "填写 DSH 凭据缝中的引用名，不在此保存明文 Secret。",
  defaultPath: "默认工作区",
  defaultPathHint: "填写本机目录的绝对路径；留空则使用 DSH 当前工作目录。",
  model: "模型",
  modelHint: "默认跟随 DSH 当前模型，也可以为此插件单独选择。",
  reasoningEffort: "思考强度",
  reasoningEffortHint: "默认跟随所选模型；只有支持的模型才提供可选项。",
  requireMention: "群里需要 @ 机器人",
  requireMentionHint: "避免机器人响应群里的每一条普通消息。",
  senderAllowlist: "仅允许指定用户私聊",
  senderAllowlistHint: "可选。每行或逗号分隔一个 Open ID；留空表示不限制。",
  privateLimit: "限制私聊用户（可选）",
  followDsh: "跟随 DSH 当前配置",
  followModel: "跟随模型默认",
  catalogLoading: "正在读取 DSH 可用模型…",
  catalogError: "模型列表暂时不可用，仍可跟随 DSH 当前配置。",
  retry: "重试",
  save: "保存更改",
  saving: "保存中…",
  saveFailed: "配置未保存，请检查字段后重试。",
  readOnly: "当前部署的配置为只读。",
  unavailable: "connect-lark 未运行，暂时无法配置。",
  overridden: "已覆盖",
  reset: "恢复默认",
  appIdPlaceholder: "cli_xxxxxxxx",
  secretPlaceholder: "CONNECT_LARK_APP_SECRET",
  pathPlaceholder: "/Users/you/project",
  privatePlaceholder: "ou_xxxxx\nou_yyyyy",
};
const en = { ...zh };

const FIELDS = [
  { path: "appId", kind: "text" },
  { path: "appSecretRef", kind: "text" },
  { path: "domain", kind: "choice", choices: ["feishu", "lark"] },
  { path: "defaultPath", kind: "text" },
  { path: "provider", kind: "text" },
  { path: "model", kind: "text" },
  { path: "reasoningEffort", kind: "text" },
  { path: "requireMention", kind: "boolean" },
  { path: "senderAllowlist", kind: "list" },
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
      if (field.kind === "choice") return field.choices.includes(text) ? { kind: "set", value: text } : undefined;
      const value = text.trim();
      return value === "" ? { kind: "clear" } : { kind: "set", value };
    },
  };
  if (field.kind === "boolean") result.format = (value) => value === true ? "true" : "false";
  if (field.kind === "list") result.format = (value) => Array.isArray(value) ? value.join("\n") : "";
  return result;
}

class LarkSettingsModel {
  constructor(ctx) {
    this.catalog = { status: "loading", groups: [], failures: [], default: null };
    this.form = new P.SettingsFormModel(ctx.configForms.get(ENTRY), FIELDS.map(definition));
    this.formState = this.form.bind(() => ({
      ...this.form.shell(),
      fields: Object.fromEntries(FIELDS.map((field) => [field.path, this.form.field(field.path)])),
    }));
    this.store = createSnapshotStore(this.projection());
    this.unsubscribe = this.formState.subscribe?.(() => this.publish());
    this.loadCatalog(ctx);
  }
  projection() {
    return { ...this.formState.getSnapshot(), catalog: this.catalog };
  }
  publish() {
    this.store.set(this.projection());
  }
  async loadCatalog(ctx) {
    this.catalog = { ...this.catalog, status: "loading" };
    this.publish();
    try {
      const response = await ctx.remote.session.modelCatalog();
      if (!response.ok) throw new Error(response.error?.message || "model catalog failed");
      this.catalog = { status: "ready", groups: response.value.groups, failures: response.value.failures || [], default: response.value.default || null };
    } catch (error) {
      this.catalog = { ...this.catalog, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  inject() {
    return {
      hooks: { larkSettings: this.store },
      ...this.form.actions(),
      refreshCatalog: () => this.loadCatalog(this.ctx),
    };
  }
  dispose() {
    this.unsubscribe?.();
    this.form.dispose();
  }
}

const styles = `
.cl-wrap{--cl-blue:#3370ff;--cl-ink:#1f2329;--cl-muted:#646a73;--cl-border:#e5e7eb;color:var(--cl-ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",sans-serif;max-width:780px;padding:2px 0 8px}
.cl-hero{position:relative;overflow:hidden;border:1px solid #dfe8fb;border-radius:16px;padding:22px 24px;background:linear-gradient(135deg,#f4f7ff 0%,#fff 72%);margin-bottom:18px}
.cl-hero-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.cl-hero h4{margin:0;font-size:20px;line-height:1.35;letter-spacing:-.02em;font-weight:680}
.cl-hero p{margin:8px 0 0;color:var(--cl-muted);font-size:13px;line-height:1.65;max-width:560px}
.cl-status{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;color:#2456b8;background:#eaf1ff;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:600}
.cl-status:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--cl-blue)}
.cl-path{display:flex;align-items:center;gap:10px;margin-top:18px;font-size:12px;color:#445066}
.cl-node{padding:6px 10px;border:1px solid #dbe4f5;background:rgba(255,255,255,.8);border-radius:8px}
.cl-arrow{color:#8a94a6;letter-spacing:2px}
.cl-card{border:1px solid var(--cl-border);border-radius:14px;background:#fff;padding:20px 22px;margin-top:14px}
.cl-section{display:flex;gap:12px;align-items:flex-start;margin-bottom:18px}
.cl-number{display:inline-flex;align-items:center;justify-content:center;min-width:27px;height:22px;border-radius:6px;background:#edf3ff;color:var(--cl-blue);font-size:11px;font-weight:700;letter-spacing:.04em}
.cl-section h5{margin:1px 0 0;font-size:14px;font-weight:650}
.cl-section p{margin:5px 0 0;color:var(--cl-muted);font-size:12px;line-height:1.55}
.cl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.cl-field{min-width:0;margin-bottom:16px}
.cl-field:last-child{margin-bottom:0}
.cl-label{display:block;font-size:12px;font-weight:600;margin-bottom:7px;color:#30343b}
.cl-input,.cl-select,.cl-textarea{box-sizing:border-box;width:100%;border:1px solid #d8dde5;border-radius:8px;background:#fff;color:var(--cl-ink);padding:9px 11px;font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.cl-input:focus,.cl-select:focus,.cl-textarea:focus,.cl-segment button:focus-visible,.cl-toggle input:focus-visible{outline:none;border-color:var(--cl-blue);box-shadow:0 0 0 3px rgba(51,112,255,.12)}
.cl-input:disabled,.cl-select:disabled,.cl-textarea:disabled{background:#f5f6f7;color:#8f959e}
.cl-hint{margin:6px 0 0;color:var(--cl-muted);font-size:11px;line-height:1.55}
.cl-segment{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:#f2f3f5;border-radius:10px;padding:4px;margin-bottom:18px}
.cl-segment button{border:1px solid transparent;border-radius:7px;background:transparent;color:#5f6672;padding:8px 12px;font:inherit;font-size:12px;cursor:pointer}
.cl-segment button[aria-checked="true"]{background:#fff;color:var(--cl-blue);border-color:#cfdcff;box-shadow:0 1px 4px rgba(31,35,41,.06);font-weight:600}
.cl-toggle{display:flex;align-items:flex-start;gap:11px;padding:2px 0}
.cl-toggle input{width:17px;height:17px;margin:2px 0 0;accent-color:var(--cl-blue);flex-shrink:0}
.cl-toggle label{font-size:13px;font-weight:550;cursor:pointer}
.cl-details{border-top:1px solid #eef0f2;margin-top:16px;padding-top:14px}
.cl-details summary{cursor:pointer;color:#3d4652;font-size:12px;font-weight:600;outline:none}
.cl-details summary:focus-visible{outline:2px solid var(--cl-blue);outline-offset:4px;border-radius:3px}
.cl-details-body{padding-top:14px}
.cl-textarea{min-height:82px;resize:vertical;line-height:1.5}
.cl-catalog-error{display:flex;align-items:center;gap:10px;color:#8a5a00;background:#fff8e8;border-radius:8px;padding:8px 10px;font-size:11px;margin-bottom:12px}
.cl-retry{border:0;background:transparent;color:var(--cl-blue);font:inherit;font-weight:600;cursor:pointer;padding:2px}
@media(max-width:560px){.cl-hero{padding:18px}.cl-hero-top{align-items:flex-start;flex-direction:column}.cl-card{padding:17px}.cl-path{font-size:11px}.cl-status{white-space:normal}}
@media(prefers-reduced-motion:reduce){.cl-input,.cl-select,.cl-textarea{transition:none}}
`;

function Field({ label, hint, children }) {
  return jsxs("div", { className: "cl-field", children: [
    jsx("span", { className: "cl-label", children: label }),
    children,
    hint ? jsx("p", { className: "cl-hint", children: hint }) : null,
  ] });
}

function TextField({ id, label, hint, value, placeholder, disabled, onEdit }) {
  return jsx(Field, { label, hint, children: jsx("input", {
    id, className: "cl-input", value: value.text, placeholder, disabled,
    onChange: (event) => onEdit(event.target.value),
  }) });
}

function Section({ number, title, hint, children }) {
  return jsxs("section", { className: "cl-card", children: [
    jsxs("div", { className: "cl-section", children: [
      jsx("span", { className: "cl-number", children: number }),
      jsxs("div", { children: [jsx("h5", { children: title }), jsx("p", { children: hint })] }),
    ] }),
    children,
  ] });
}

function modelName(catalog, provider, model) {
  if (!provider || !model) return "";
  for (const group of catalog.groups || []) {
    if (group.id !== provider) continue;
    const found = group.models.find((item) => item.id === model);
    if (found) return found.name;
  }
  return model;
}

function LarkConfigCard(props) {
  const state = props.useLarkSettings((snapshot) => snapshot);
  const t = props.t;
  const disabled = !state.writable;
  const value = (path) => state.fields[path];
  const edit = (path) => (text) => props.edit(path, text);
  const route = value("provider").text && value("model").text ? value("provider").text + "/" + value("model").text : "";
  const selectedGroup = (state.catalog.groups || []).find((group) => group.id === value("provider").text);
  const selectedModel = selectedGroup?.models.find((model) => model.id === value("model").text);
  const efforts = selectedModel?.reasoning?.efforts || [];
  const defaultRoute = state.catalog.default;
  const defaultLabel = defaultRoute ? t("followDsh") + " · " + modelName(state.catalog, defaultRoute.provider, defaultRoute.model) : t("followDsh");
  return jsxs("div", { className: "cl-wrap", children: [
    jsx("style", { children: styles }),
    jsxs("div", { className: "cl-hero", children: [
      jsxs("div", { className: "cl-hero-top", children: [
        jsxs("div", { children: [
          jsx("h4", { children: t("heroTitle") }),
          jsx("p", { children: t("heroDescription") }),
        ] }),
        jsx("span", { className: "cl-status", children: t("heroStatus") }),
      ] }),
      jsxs("div", { className: "cl-path", "aria-hidden": "true", children: [
        jsx("span", { className: "cl-node", children: value("domain").text === "lark" ? "Lark" : "飞书" }),
        jsx("span", { className: "cl-arrow", children: "→" }),
        jsx("span", { className: "cl-node", children: "DSH Agent" }),
      ] }),
    ] }),
    jsx(P.SettingsForm, {
      labels: { unavailable: t("unavailable"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") },
      state,
      onSave: props.save,
      onDiscard: props.discard,
      children: [
        jsx(Section, { number: "01", title: t("connection"), hint: t("connectionHint"), children: [
          jsx("div", { className: "cl-segment", role: "radiogroup", "aria-label": t("domain"), children: ["feishu", "lark"].map((domain) => jsx("button", {
            type: "button", role: "radio", "aria-checked": value("domain").text === domain,
            disabled, onClick: () => edit("domain")(domain), children: t(domain),
          }, domain)) }),
          jsxs("div", { className: "cl-grid", children: [
            jsx(TextField, { id: "connect-lark-appId", label: t("appId"), hint: t("appIdHint"), value: value("appId"), placeholder: t("appIdPlaceholder"), disabled, onEdit: edit("appId") }),
            jsx(TextField, { id: "connect-lark-appSecretRef", label: t("appSecretRef"), hint: t("appSecretRefHint"), value: value("appSecretRef"), placeholder: t("secretPlaceholder"), disabled, onEdit: edit("appSecretRef") }),
          ] }),
        ] }, "connection"),
        jsx(Section, { number: "02", title: t("workspace"), hint: t("workspaceHint"), children: [
          jsx(TextField, { id: "connect-lark-defaultPath", label: t("defaultPath"), hint: t("defaultPathHint"), value: value("defaultPath"), placeholder: t("pathPlaceholder"), disabled, onEdit: edit("defaultPath") }),
          state.catalog.status === "error" ? jsxs("div", { className: "cl-catalog-error", children: [t("catalogError"), jsx("button", { className: "cl-retry", type: "button", onClick: props.refreshCatalog, children: t("retry") })] }) : null,
          jsxs("div", { className: "cl-grid", children: [
            jsx(Field, { label: t("model"), hint: t("modelHint"), children: jsxs("select", {
              id: "connect-lark-model", className: "cl-select", value: route, disabled: disabled || state.catalog.status === "loading",
              onChange: (event) => {
                const next = event.target.value;
                if (!next) {
                  edit("provider")("");
                  edit("model")("");
                } else {
                  const [provider, model] = next.split("/");
                  edit("provider")(provider);
                  edit("model")(model);
                }
                edit("reasoningEffort")("");
              },
              children: [
                jsx("option", { value: "", children: state.catalog.status === "loading" ? t("catalogLoading") : defaultLabel }),
                route && !(state.catalog.groups || []).some((group) => group.id + "/" + value("model").text === route) ? jsx("option", { value: route, children: route }) : null,
                (state.catalog.groups || []).map((group) => jsx("optgroup", { label: group.name, children: group.models.map((model) => jsx("option", { value: group.id + "/" + model.id, children: model.name }, group.id + "/" + model.id)) }, group.id)),
              ],
            }) }),
            jsx(Field, { label: t("reasoningEffort"), hint: t("reasoningEffortHint"), children: jsxs("select", {
              id: "connect-lark-reasoningEffort", className: "cl-select", value: value("reasoningEffort").text,
              disabled: disabled || !selectedModel?.reasoning,
              onChange: (event) => edit("reasoningEffort")(event.target.value),
              children: [
                jsx("option", { value: "", children: t("followModel") }),
                efforts.map((effort) => jsx("option", { value: effort.id, children: effort.name }, effort.id)),
              ],
            }) }),
          ] }),
        ] }, "workspace"),
        jsx(Section, { number: "03", title: t("trigger"), hint: t("triggerHint"), children: [
          jsxs("div", { className: "cl-toggle", children: [
            jsx("input", { id: "connect-lark-requireMention", type: "checkbox", checked: value("requireMention").text === "true", disabled, onChange: (event) => edit("requireMention")(event.target.checked ? "true" : "false") }),
            jsxs("div", { children: [
              jsx("label", { htmlFor: "connect-lark-requireMention", children: t("requireMention") }),
              jsx("p", { className: "cl-hint", children: t("requireMentionHint") }),
            ] }),
          ] }),
          jsxs("details", { className: "cl-details", children: [
            jsx("summary", { children: t("privateLimit") }),
            jsx("div", { className: "cl-details-body", children: jsx(Field, { label: t("senderAllowlist"), hint: t("senderAllowlistHint"), children: jsx("textarea", {
              id: "connect-lark-senderAllowlist", className: "cl-textarea", value: value("senderAllowlist").text,
              placeholder: t("privatePlaceholder"), disabled, onChange: (event) => edit("senderAllowlist")(event.target.value),
            }) }) }),
          ] }),
        ] }, "trigger"),
      ],
    }),
  ] });
}

function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "connect-lark: dictionaries");
  const model = new LarkSettingsModel(ctx);
  model.ctx = ctx;
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
