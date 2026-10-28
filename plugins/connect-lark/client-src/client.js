// Native settings page for @oh-summy/connect-lark.
const { jsx, jsxs } = require("react/jsx-runtime");
const P = require("@deepseek-ai/dsh-client-ui-primitives");
const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

const NS = "connect-lark.settings";
const PACKAGE = "@oh-summy/connect-lark";
const ENTRY = "connect-lark";
const inject = ["slots", "locale", "remote", "remote.session", "remote.directoryPicker", "workspaces", "configForms"];

const zh = {
  heroTitle: "把飞书消息交给 DSH",
  heroDescription: "连接应用后，私聊和群里的消息会进入你选择的 DSH 工作区。",
  heroStatus: "插件开启后自动连接",
  connection: "连接飞书",
  connectionHint: "只需应用信息，国内和海外可以随时切换。",
  workspace: "工作区与模型",
  workspaceHint: "默认沿用 DSH 当前的工作方式，需要时再覆盖。",
  trigger: "触发方式",
  triggerHint: "私聊由飞书应用权限决定；群里 @ 机器人即可响应。",
  feishu: "飞书 · 国内",
  lark: "Lark · 海外",
  appId: "App ID",
  appIdHint: "应用信息仅保存在本机 DSH 配置中，页面默认掩码显示。",
  appSecretRef: "App Secret 凭据引用",
  appSecretRefHint: "Secret 保存在 DSH 凭据缝，不进入 Git，也不会在页面显示。",
  defaultPath: "默认工作区",
  defaultPathHint: "从 DSH 工作区中选择，或点击「修改」选择其他目录。",
  editWorkspace: "修改",
  addingWorkspace: "正在选择目录…",
  workspaceFailed: "未能添加工作区，请重试。",
  model: "模型",
  modelHint: "默认使用 DSH 新会话的模型；只有需要时才单独覆盖。",
  reasoningEffort: "思考强度",
  reasoningEffortHint: "默认使用 DSH 新会话的思考强度。",
  followDsh: "跟随 DSH 当前配置",
  followModel: "跟随模型默认",
  searchModels: "搜索模型或提供方…",
  noModels: "没有匹配的模型",
  catalogLoading: "正在读取 DSH 可用模型…",
  catalogError: "模型列表暂时不可用，仍可跟随 DSH 当前配置。",
  retry: "重试",
  save: "保存更改",
  saving: "保存中…",
  saveFailed: "配置未保存，请检查字段后重试。",
  readOnly: "当前部署的配置为只读。",
  unavailable: "connect-lark 未运行，暂时无法配置。",
  appIdPlaceholder: "cli_xxxxxxxx",
  secretPlaceholder: "CONNECT_LARK_APP_SECRET",
  guideButton: "创建应用与权限",
  guideTitle: "创建飞书应用",
  guideIntro: "在飞书开放平台完成下面几步，然后回到这里填写应用信息。",
  guideStep1: "创建自建应用",
  guideStep1Text: "打开飞书开放平台，创建企业自建应用，并在「凭证与基础信息」里找到 App ID 和 App Secret。",
  guideStep2: "启用机器人能力",
  guideStep2Text: "在「应用能力」中添加机器人。私聊是否可用由飞书应用自身的使用权限决定。",
  guideStep3: "配置权限与事件",
  guideStep3Text: "在「权限管理」开通下列权限；在「事件订阅」选择 WebSocket 长连接并添加消息接收事件。",
  guideOpen: "打开飞书开放平台",
  guideCopy: "复制配置清单",
  guideCopied: "已复制",
  guideClose: "关闭",
  guideNote: "这是一份最小配置清单，不是密钥；可以复制给应用管理员核对。",
  fixedTrigger: "群里 @ 机器人即可触发，无需额外设置。",
};
const en = { ...zh };

const GUIDE_JSON = JSON.stringify({
  capability: "机器人",
  permissions: ["im:message", "im:message:send_as_bot", "im:resource"],
  event: "im.message.receive_v1",
  connection: "WebSocket 长连接",
}, null, 2);

const FIELDS = [
  { path: "appId", kind: "text" },
  { path: "appSecretPreview", kind: "text" },
  { path: "domain", kind: "choice", choices: ["feishu", "lark"] },
  { path: "defaultPath", kind: "text" },
  { path: "provider", kind: "text" },
  { path: "model", kind: "text" },
  { path: "reasoningEffort", kind: "text" },
  { path: "permissionPreset", kind: "text" },
];

function definition(field) {
  const base = P.settingsTextField(field.path);
  return {
    ...base,
    parse(text) {
      if (field.kind === "choice") return field.choices.includes(text) ? { kind: "set", value: text } : undefined;
      const value = text.trim();
      return value === "" ? { kind: "clear" } : { kind: "set", value };
    },
  };
}

class LarkSettingsModel {
  constructor(ctx) {
    this.ctx = ctx;
    this.workspaces = ctx.get("workspaces");
    this.catalog = { status: "loading", groups: [], failures: [], default: null };
    this.secretDraft = "";
    this.scope = ctx.configForms.get(ENTRY);
    this.form = new P.SettingsFormModel(this.scope, FIELDS.map(definition));
    this.formState = this.form.bind(() => ({
      ...this.form.shell(),
      fields: Object.fromEntries(FIELDS.map((field) => [field.path, this.form.field(field.path)])),
    }));
    this.store = createSnapshotStore(this.projection());
    this.unsubscribe = this.formState.subscribe?.(() => this.publish());
    this.unsubscribeWorkspaces = this.workspaces.list.subscribe?.(() => this.publish());
    this.loadCatalog();
  }
  projection() {
    const snapshot = this.formState.getSnapshot();
    return { ...snapshot, dirty: snapshot.dirty || this.secretDraft.length > 0, secretDraft: this.secretDraft, catalog: this.catalog, workspaces: this.workspaces.list.getSnapshot() };
  }
  publish() { this.store.set(this.projection()); }
  async loadCatalog() {
    this.catalog = { ...this.catalog, status: "loading" };
    this.publish();
    try {
      const response = await this.ctx.remote.session.modelCatalog();
      if (!response.ok) throw new Error(response.error?.message || "model catalog failed");
      this.catalog = { status: "ready", groups: response.value.groups, failures: response.value.failures || [], default: response.value.default || null };
    } catch (error) {
      this.catalog = { ...this.catalog, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    this.publish();
  }
  async listDirectory(path) {
    const response = await this.ctx.remote.directoryPicker.list(path);
    if (!response.ok) throw new Error(response.error?.message || "directory listing failed");
    return response.value;
  }
  async createDirectory(path, name) {
    const response = await this.ctx.remote.directoryPicker.createDirectory(path, name);
    if (!response.ok) throw new Error(response.error?.message || "directory creation failed");
    return response.value;
  }
  async saveSecret(value) {
    const ref = this.scope.getSnapshot().value?.appSecretRef || "CONNECT_LARK_APP_SECRET";
    const response = await this.ctx.remote.credentials.set(ref, value);
    if (!response.ok) throw new Error(response.error?.message || "credential write failed");
    this.form.actions().edit("appSecretPreview", value.slice(0, 5));
    this.secretDraft = "";
    this.publish();
  }
  async save() {
    if (this.secretDraft) await this.saveSecret(this.secretDraft);
    return this.form.actions().save();
  }
  inject() {
    return {
      hooks: { larkSettings: this.store },
      ...this.form.actions(),
      save: () => this.save(),
      refreshCatalog: () => this.loadCatalog(),
      listDirectory: (path) => this.listDirectory(path),
      createDirectory: (path, name) => this.createDirectory(path, name),
      saveSecret: (value) => this.saveSecret(value),
      editSecret: (text) => { this.secretDraft = text; this.publish(); },
    };
  }
  dispose() {
    this.unsubscribe?.();
    this.unsubscribeWorkspaces?.();
    this.form.dispose();
  }
}

const styles = `
.cl-wrap{--cl-blue:#3370ff;--cl-ink:#1f2329;--cl-muted:#646a73;--cl-border:#e5e7eb;color:var(--cl-ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",sans-serif;max-width:780px;padding:2px 0 8px}
.cl-hero{border:1px solid #dfe8fb;border-radius:16px;padding:22px 24px;background:linear-gradient(135deg,#f4f7ff 0%,#fff 72%);margin-bottom:18px}
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
.cl-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.cl-guide-link{border:0;background:transparent;color:var(--cl-blue);font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:2px 0;white-space:nowrap}
.cl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.cl-field{min-width:0;margin-bottom:16px}
.cl-field:last-child{margin-bottom:0}
.cl-label{display:block;font-size:12px;font-weight:600;margin-bottom:7px;color:#30343b}
.cl-input,.cl-select,.cl-picker-trigger{box-sizing:border-box;width:100%;border:1px solid #d8dde5;border-radius:8px;background:#fff;color:var(--cl-ink);padding:9px 11px;font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.cl-input:focus,.cl-select:focus,.cl-picker-trigger:focus-visible,.cl-segment button:focus-visible{outline:none;border-color:var(--cl-blue);box-shadow:0 0 0 3px rgba(51,112,255,.12)}
.cl-input:disabled,.cl-select:disabled,.cl-picker-trigger:disabled{background:#f5f6f7;color:#8f959e}
.cl-hint{margin:6px 0 0;color:var(--cl-muted);font-size:11px;line-height:1.55}
.cl-segment{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:#f2f3f5;border-radius:10px;padding:4px;margin-bottom:18px}
.cl-segment button{border:1px solid transparent;border-radius:7px;background:transparent;color:#5f6672;padding:8px 12px;font:inherit;font-size:12px;cursor:pointer}
.cl-segment button[aria-checked="true"]{background:#fff;color:var(--cl-blue);border-color:#cfdcff;box-shadow:0 1px 4px rgba(31,35,41,.06);font-weight:600}
.cl-workspace-field{margin-bottom:18px}
.cl-workspace-field-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:7px}
.cl-workspace-field-head .cl-label{margin-bottom:0}
.cl-workspace-edit{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:6px;background:transparent;color:#526174;padding:3px 6px;font:inherit;font-size:11px;font-weight:550;cursor:pointer}
.cl-workspace-edit:hover{background:#f0f4fa;color:var(--cl-blue)}
.cl-workspace-edit:focus-visible{outline:2px solid var(--cl-blue);outline-offset:2px}
.cl-browser-modal{width:min(680px,100%)}
.cl-browser-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin:18px 0 12px}
.cl-browser-list{height:340px;overflow:auto;border:1px solid #eceff3;border-radius:10px;padding:6px}
.cl-browser-entry{display:block;width:100%;border:0;border-radius:7px;background:transparent;color:#374151;text-align:left;padding:8px 10px;font:inherit;font-size:12px;cursor:pointer}
.cl-browser-entry:hover{background:#f2f5fa}
.cl-browser-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}
.cl-browser-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cl-browser-create{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:14px}
@media(max-width:560px){.cl-browser-list{height:280px}.cl-browser-footer{align-items:flex-start;flex-direction:column}}
.cl-picker{position:relative;min-width:0}
.cl-picker-trigger{display:flex;align-items:center;gap:9px;text-align:left;cursor:pointer;min-height:54px}
.cl-picker-text{min-width:0;flex:1}
.cl-picker-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px}
.cl-picker-sub{display:block;color:var(--cl-muted);font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-chevron{color:#7a8492;font-size:11px;flex-shrink:0}
.cl-menu-shield{position:fixed;inset:0;z-index:60;background:transparent}
.cl-menu{position:absolute;z-index:61;left:0;right:0;top:calc(100% + 7px);background:#fff;border:1px solid #e1e5eb;border-radius:12px;box-shadow:0 12px 36px rgba(31,35,41,.14);padding:8px;max-height:330px;overflow:auto}
.cl-search{box-sizing:border-box;width:100%;border:1px solid #e0e4ea;border-radius:7px;padding:8px 9px;font:inherit;font-size:12px;outline:none;margin-bottom:7px}
.cl-search:focus{border-color:var(--cl-blue)}
.cl-group-label{padding:8px 8px 5px;color:#8a94a6;font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.05em}
.cl-option{display:flex;align-items:center;gap:9px;width:100%;border:0;border-radius:7px;background:transparent;text-align:left;padding:9px 8px;color:var(--cl-ink);font:inherit;cursor:pointer}
.cl-option:hover{background:#f3f6fb}
.cl-option[aria-selected="true"]{background:#edf3ff;color:#2456b8}
.cl-option-text{flex:1;min-width:0}
.cl-option-name{display:block;font-size:12px;font-weight:550}
.cl-option-desc{display:block;color:var(--cl-muted);font-size:10px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-check{color:var(--cl-blue);font-size:12px;font-weight:700}
.cl-empty{padding:18px;text-align:center;color:var(--cl-muted);font-size:12px}
.cl-catalog-error{display:flex;align-items:center;gap:10px;color:#8a5a00;background:#fff8e8;border-radius:8px;padding:8px 10px;font-size:11px;margin-bottom:12px}
.cl-retry{border:0;background:transparent;color:var(--cl-blue);font:inherit;font-weight:600;cursor:pointer;padding:2px}
.cl-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(20,26,36,.38);display:flex;align-items:center;justify-content:center;padding:22px;backdrop-filter:blur(3px)}
.cl-modal{width:min(600px,100%);max-height:min(760px,90vh);overflow:auto;background:#fff;border-radius:18px;box-shadow:0 24px 80px rgba(20,26,36,.25);padding:26px}
.cl-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.cl-modal h3{margin:0;font-size:20px;letter-spacing:-.02em}
.cl-modal-intro{margin:8px 0 20px;color:var(--cl-muted);font-size:12px;line-height:1.65}
.cl-close{border:0;background:#f2f3f5;color:#59616d;border-radius:8px;width:30px;height:30px;font:inherit;cursor:pointer;flex-shrink:0}
.cl-step{display:flex;gap:13px;margin:18px 0}
.cl-step-number{display:inline-flex;align-items:center;justify-content:center;width:25px;height:25px;border-radius:50%;background:#edf3ff;color:var(--cl-blue);font-size:11px;font-weight:700;flex-shrink:0}
.cl-step h4{margin:1px 0 5px;font-size:13px}
.cl-step p{margin:0;color:var(--cl-muted);font-size:12px;line-height:1.65}
.cl-code{position:relative;background:#161b26;color:#dce6f5;border-radius:12px;padding:16px;font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow:auto}
.cl-modal-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;flex-wrap:wrap}
.cl-primary,.cl-secondary{display:inline-flex;align-items:center;justify-content:center;border-radius:8px;padding:9px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none}
.cl-primary{border:1px solid var(--cl-blue);background:var(--cl-blue);color:#fff}
.cl-secondary{border:1px solid #d8dde5;background:#fff;color:#374151}
.cl-modal-note{color:var(--cl-muted);font-size:10px;margin-top:12px;line-height:1.5}
@media(max-width:560px){.cl-hero{padding:18px}.cl-hero-top{align-items:flex-start;flex-direction:column}.cl-card{padding:17px}.cl-status{white-space:normal}.cl-modal{padding:20px}.cl-section-head{flex-direction:column}.cl-guide-link{align-self:flex-start}}
@media(prefers-reduced-motion:reduce){.cl-input,.cl-select,.cl-picker-trigger{transition:none}.cl-modal-backdrop{backdrop-filter:none}}
`;

function Field({ label, hint, children }) {
  return jsxs("div", { className: "cl-field", children: [
    jsx("span", { className: "cl-label", children: label }), children,
    hint ? jsx("p", { className: "cl-hint", children: hint }) : null,
  ] });
}

function TextField({ id, label, hint, value, placeholder, disabled, onEdit, mask = false }) {
  const [focused, setFocused] = React.useState(false);
  const text = mask && !focused && value.text.length > 5 ? value.text.slice(0, 5) + "*****" : value.text;
  return jsx(Field, { label, hint, children: jsx("input", {
    id, className: "cl-input", value: text, placeholder, disabled,
    onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    onChange: (event) => onEdit(event.target.value),
  }) });
}

function SecretField({ state, onEdit, t, disabled }) {
  const [focused, setFocused] = React.useState(false);
  const preview = state.fields.appSecretPreview.text;
  const text = focused ? state.secretDraft : preview ? preview + "*****" : "";
  return jsx(Field, { label: "App Secret", hint: "完整 Secret 只保存在 DSH 凭据缝；页面只显示前 5 位 + 掩码。", children: jsx("input", {
    id: "connect-lark-appSecret", className: "cl-input", type: focused ? "password" : "text",
    value: text, placeholder: "输入新的 App Secret 以更换", disabled,
    onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    onChange: (event) => onEdit(event.target.value),
  }) });
}

function Section({ number, title, hint, action, children }) {
  return jsxs("section", { className: "cl-card", children: [
    jsxs("div", { className: "cl-section-head", children: [
      jsxs("div", { className: "cl-section", children: [
        jsx("span", { className: "cl-number", children: number }),
        jsxs("div", { children: [jsx("h5", { children: title }), jsx("p", { children: hint })] }),
      ] }),
      action || null,
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

function ModelPicker({ state, value, edit, t, disabled }) {
  const [open, setOpen] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const route = value("provider").text && value("model").text ? value("provider").text + "/" + value("model").text : "";
  const selectedGroup = (state.catalog.groups || []).find((group) => group.id === value("provider").text);
  const selectedModel = selectedGroup?.models.find((model) => model.id === value("model").text);
  const efforts = selectedModel?.reasoning?.efforts || [];
  const defaultRoute = state.catalog.default;
  const defaultName = defaultRoute ? modelName(state.catalog, defaultRoute.provider, defaultRoute.model) : "";
  const currentName = route ? modelName(state.catalog, value("provider").text, value("model").text) : t("followDsh");
  const currentEffort = value("reasoningEffort").text || t("followModel");
  const filteredGroups = (state.catalog.groups || []).map((group) => ({
    ...group,
    models: group.models.filter((model) => (group.name + " " + model.name).toLowerCase().includes(query.trim().toLowerCase())),
  })).filter((group) => group.models.length > 0);
  const close = () => setOpen(null);
  return jsxs("div", { className: "cl-grid", children: [
    jsxs("div", { className: "cl-picker", children: [
      jsx("span", { className: "cl-label", children: t("model") }),
      jsxs("button", { type: "button", className: "cl-picker-trigger", disabled: disabled || state.catalog.status === "loading", onClick: () => setOpen(open === "model" ? null : "model"), children: [
        jsxs("span", { className: "cl-picker-text", children: [
          jsx("span", { className: "cl-picker-title", children: currentName }),
          jsx("span", { className: "cl-picker-sub", children: route ? value("provider").text : defaultName ? "DSH 默认 · " + defaultName : t("followDsh") }),
        ] }),
        jsx("span", { className: "cl-chevron", children: open === "model" ? "▲" : "▼" }),
      ] }),
      jsx("p", { className: "cl-hint", children: t("modelHint") }),
      open === "model" ? jsxs(React.Fragment, { children: [
        jsx("div", { className: "cl-menu-shield", onClick: close }),
        jsxs("div", { className: "cl-menu", role: "listbox", children: [
          jsx("input", { className: "cl-search", value: query, placeholder: t("searchModels"), autoFocus: true, onChange: (event) => setQuery(event.target.value) }),
          query.trim() === "" ? jsx("button", { className: "cl-option", role: "option", "aria-selected": !route, onClick: () => { edit("provider")(""); edit("model")(""); edit("reasoningEffort")(""); close(); }, children: jsxs("span", { className: "cl-option-text", children: [
            jsx("span", { className: "cl-option-name", children: t("followDsh") }),
            defaultName ? jsx("span", { className: "cl-option-desc", children: "DSH 默认 · " + defaultName }) : null,
          ] }) }) : null,
          filteredGroups.map((group) => jsxs("div", { children: [
            jsx("div", { className: "cl-group-label", children: group.name }),
            group.models.map((model) => jsx("button", {
              className: "cl-option", role: "option", "aria-selected": route === group.id + "/" + model.id,
              onClick: () => { edit("provider")(group.id); edit("model")(model.id); edit("reasoningEffort")(""); close(); },
              children: jsxs("span", { className: "cl-option-text", children: [
                jsx("span", { className: "cl-option-name", children: model.name }),
                model.description ? jsx("span", { className: "cl-option-desc", children: model.description }) : null,
              ] }),
            }, group.id + "/" + model.id)),
          ] }, group.id)),
          filteredGroups.length === 0 ? jsx("div", { className: "cl-empty", children: t("noModels") }) : null,
        ] }),
      ] }) : null,
    ] }),
    jsxs("div", { className: "cl-picker", children: [
      jsx("span", { className: "cl-label", children: t("reasoningEffort") }),
      jsxs("button", { type: "button", className: "cl-picker-trigger", disabled: disabled || !selectedModel?.reasoning, onClick: () => setOpen(open === "effort" ? null : "effort"), children: [
        jsxs("span", { className: "cl-picker-text", children: [
          jsx("span", { className: "cl-picker-title", children: currentEffort }),
          jsx("span", { className: "cl-picker-sub", children: selectedModel ? selectedModel.name : t("followDsh") }),
        ] }),
        jsx("span", { className: "cl-chevron", children: open === "effort" ? "▲" : "▼" }),
      ] }),
      jsx("p", { className: "cl-hint", children: t("reasoningEffortHint") }),
      open === "effort" ? jsxs(React.Fragment, { children: [
        jsx("div", { className: "cl-menu-shield", onClick: close }),
        jsxs("div", { className: "cl-menu", role: "listbox", children: [
          jsx("button", { className: "cl-option", role: "option", "aria-selected": !value("reasoningEffort").text, onClick: () => { edit("reasoningEffort")(""); close(); }, children: jsx("span", { className: "cl-option-name", children: t("followModel") }) }),
          efforts.map((effort) => jsx("button", {
            className: "cl-option", role: "option", "aria-selected": value("reasoningEffort").text === effort.id,
            onClick: () => { edit("reasoningEffort")(effort.id); close(); },
            children: jsxs("span", { className: "cl-option-text", children: [
              jsx("span", { className: "cl-option-name", children: effort.name }),
              effort.description ? jsx("span", { className: "cl-option-desc", children: effort.description }) : null,
            ] }),
          }, effort.id)),
        ] }),
      ] }) : null,
    ] }),
  ] });
}

const PERMISSION_OPTIONS = [
  { value: "", label: "跟随 DSH 默认", description: "使用 DSH 当前的权限配置，不单独覆盖。" },
  { value: "read-only", label: "仅可查看", description: "只读取和分析，不修改文件或执行写操作。" },
  { value: "workspace-write", label: "工作区内修改", description: "允许修改当前工作区，敏感操作仍需要确认。" },
  { value: "danger-full-access", label: "完全权限", description: "直接执行更多操作，请只在你信任的任务中使用。" },
  { value: "auto", label: "自动审查", description: "每次工具调用前由模型审查，可能消耗额外 token。" },
];

function PermissionPicker({ value, onEdit, disabled }) {
  const [open, setOpen] = React.useState(false);
  const current = PERMISSION_OPTIONS.find((option) => option.value === value.text) || PERMISSION_OPTIONS[0];
  return jsxs("div", { className: "cl-picker", children: [
    jsx("span", { className: "cl-label", children: "权限模式" }),
    jsxs("button", { type: "button", className: "cl-picker-trigger", disabled, onClick: () => setOpen(!open), children: [
      jsxs("span", { className: "cl-picker-text", children: [
        jsx("span", { className: "cl-picker-title", children: current.label }),
        jsx("span", { className: "cl-picker-sub", children: current.description }),
      ] }),
      jsx("span", { className: "cl-chevron", children: open ? "▲" : "▼" }),
    ] }),
    jsx("p", { className: "cl-hint", children: "控制机器人可以读取、修改或执行哪些操作。" }),
    open ? jsxs(React.Fragment, { children: [
      jsx("div", { className: "cl-menu-shield", onClick: () => setOpen(false) }),
      jsx("div", { className: "cl-menu", role: "listbox", children: PERMISSION_OPTIONS.map((option) => jsx("button", {
        type: "button", className: "cl-option", role: "option", "aria-selected": option.value === current.value,
        onClick: () => { onEdit(option.value); setOpen(false); },
        children: jsxs("span", { className: "cl-option-text", children: [
          jsx("span", { className: "cl-option-name", children: option.label }),
          jsx("span", { className: "cl-option-desc", children: option.description }),
        ] }),
      }, option.value || "default")) }),
    ] }) : null,
  ] });
}

function WorkspaceDialog({ listDirectory, createDirectory, onPick, onClose, t }) {
  const [listing, setListing] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [pathInput, setPathInput] = React.useState("");
  const [showHidden, setShowHidden] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const load = async (path) => {
    setLoading(true); setError("");
    try {
      const value = await listDirectory(path);
      setListing(value);
      setPathInput(value.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  React.useEffect(() => { load(); }, []);
  const create = async () => {
    if (!folderName.trim() || !listing) return;
    setLoading(true);
    try {
      await createDirectory(listing.path, folderName.trim());
      setFolderName(""); setCreating(false);
      await load(listing.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
  };
  return jsx("div", { className: "cl-modal-backdrop", onClick: onClose, children: jsxs("div", {
    className: "cl-modal cl-browser-modal", role: "dialog", "aria-modal": "true", "aria-label": "选择工作区目录", onClick: (event) => event.stopPropagation(),
    children: [
      jsxs("div", { className: "cl-modal-head", children: [
        jsx("h3", { children: "选择工作区目录" }),
        jsx("button", { className: "cl-close", type: "button", "aria-label": "关闭", onClick: onClose, children: "×" }),
      ] }),
      jsxs("div", { className: "cl-browser-path", children: [
        jsx("input", { className: "cl-input", value: pathInput, "aria-label": "目录路径", onChange: (event) => setPathInput(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") load(pathInput); } }),
        listing?.home ? jsx("button", { type: "button", className: "cl-secondary", onClick: () => load(listing.home), children: "主目录" }) : null,
      ] }),
      error ? jsx("p", { className: "cl-hint", role: "alert", children: error }) : null,
      jsx("div", { className: "cl-browser-list", children: loading ? jsx("div", { className: "cl-empty", children: "正在读取目录…" }) : (listing?.entries || []).filter((entry) => showHidden || !entry.hidden).map((entry) => jsx("button", {
        type: "button", className: "cl-browser-entry", onClick: () => load(entry.path), children: jsxs("span", { children: ["▸ ", entry.name] }),
      }, entry.path)) }),
      listing?.truncated ? jsx("p", { className: "cl-hint", children: "文件夹过多，仅显示开头部分。" }) : null,
      jsxs("div", { className: "cl-browser-footer", children: [
        jsxs("div", { className: "cl-browser-tools", children: [
          jsx("button", { type: "button", className: "cl-secondary", onClick: () => setCreating(!creating), children: "+ 新建文件夹" }),
          jsx("button", { type: "button", className: "cl-guide-link", onClick: () => setShowHidden(!showHidden), children: showHidden ? "隐藏系统文件" : "显示隐藏文件" }),
        ] }),
        jsxs("div", { className: "cl-modal-actions", children: [
          jsx("button", { type: "button", className: "cl-secondary", onClick: onClose, children: "取消" }),
          jsx("button", { type: "button", className: "cl-primary", disabled: !listing, onClick: () => onPick(listing.path), children: "打开" }),
        ] }),
      ] }),
      creating ? jsxs("div", { className: "cl-browser-create", children: [
        jsx("input", { className: "cl-input", value: folderName, placeholder: "文件夹名称", onChange: (event) => setFolderName(event.target.value) }),
        jsx("button", { type: "button", className: "cl-primary", onClick: create, children: "创建" }),
      ] }) : null,
    ],
  }) });
}

function WorkspacePicker({ state, value, onEdit, onBrowse, onCreateDirectory, t, disabled }) {
  const [open, setOpen] = React.useState(false);
  const items = state.workspaces?.items || [];
  return jsxs("div", { children: [
    jsxs("div", { className: "cl-workspace-field", children: [
      jsxs("div", { className: "cl-workspace-field-head", children: [
        jsx("span", { className: "cl-label", children: t("defaultPath") }),
        jsx("button", { type: "button", className: "cl-workspace-edit", disabled, onClick: () => setOpen(true), children: "✎ " + t("editWorkspace") }),
      ] }),
      jsxs("select", {
        id: "connect-lark-defaultPath", className: "cl-select", value: value.text, disabled,
        onChange: (event) => onEdit(event.target.value),
        children: [
          jsx("option", { value: "", children: t("followDsh") }),
          value.text && !items.some((item) => item.path === value.text) ? jsx("option", { value: value.text, children: value.text }) : null,
          items.map((item) => jsx("option", { value: item.path, children: item.title + " · " + item.path }, item.workspaceId)),
        ],
      }),
      jsx("p", { className: "cl-hint", children: t("defaultPathHint") }),
    ] }),
    open ? jsx(WorkspaceDialog, {
      listDirectory: onBrowse,
      createDirectory: onCreateDirectory,
      onPick: (path) => { onEdit(path); setOpen(false); },
      onClose: () => setOpen(false), t,
    }) : null,
  ] });
}


function GuideDialog({ onClose, t }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    const listener = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [onClose]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(GUIDE_JSON); setCopied(true); } catch { setCopied(false); }
  };
  return jsx("div", { className: "cl-modal-backdrop", onClick: onClose, children: jsxs("div", {
    className: "cl-modal", role: "dialog", "aria-modal": "true", "aria-label": t("guideTitle"), onClick: (event) => event.stopPropagation(),
    children: [
      jsxs("div", { className: "cl-modal-head", children: [
        jsx("h3", { children: t("guideTitle") }),
        jsx("button", { className: "cl-close", type: "button", "aria-label": t("guideClose"), onClick: onClose, children: "×" }),
      ] }),
      jsx("p", { className: "cl-modal-intro", children: t("guideIntro") }),
      [
        [t("guideStep1"), t("guideStep1Text")],
        [t("guideStep2"), t("guideStep2Text")],
        [t("guideStep3"), t("guideStep3Text")],
      ].map(([title, text], index) => jsxs("div", { className: "cl-step", children: [
        jsx("span", { className: "cl-step-number", children: String(index + 1).padStart(2, "0") }),
        jsxs("div", { children: [jsx("h4", { children: title }), jsx("p", { children: text })] }),
      ] }, title)),
      jsx("pre", { className: "cl-code", children: GUIDE_JSON }),
      jsxs("div", { className: "cl-modal-actions", children: [
        jsx("a", { className: "cl-primary", href: "https://open.feishu.cn/app", target: "_blank", rel: "noreferrer", children: t("guideOpen") + " ↗" }),
        jsx("button", { className: "cl-secondary", type: "button", onClick: copy, children: copied ? t("guideCopied") + " ✓" : t("guideCopy") }),
      ] }),
      jsx("p", { className: "cl-modal-note", children: t("guideNote") }),
    ],
  }) });
}

function LarkConfigCard(props) {
  const state = props.useLarkSettings((snapshot) => snapshot);
  const [guideOpen, setGuideOpen] = React.useState(false);
  const t = props.t;
  const disabled = !state.writable;
  const value = (path) => state.fields[path];
  const edit = (path) => (text) => props.edit(path, text);
  return jsxs("div", { className: "cl-wrap", children: [
    jsx("style", { children: styles }),
    jsxs("div", { className: "cl-hero", children: [
      jsxs("div", { className: "cl-hero-top", children: [
        jsxs("div", { children: [jsx("h4", { children: t("heroTitle") }), jsx("p", { children: t("heroDescription") })] }),
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
      state, onSave: props.save, onDiscard: props.discard,
      children: [
        jsx(Section, { number: "01", title: t("connection"), hint: t("connectionHint"), action: jsx("button", { type: "button", className: "cl-guide-link", onClick: () => setGuideOpen(true), children: t("guideButton") + " ↗" }), children: [
          jsx("div", { className: "cl-segment", role: "radiogroup", "aria-label": t("domain"), children: ["feishu", "lark"].map((domain) => jsx("button", {
            type: "button", role: "radio", "aria-checked": value("domain").text === domain,
            disabled, onClick: () => edit("domain")(domain), children: t(domain),
          }, domain)) }),
          jsxs("div", { className: "cl-grid", children: [
            jsx(TextField, { id: "connect-lark-appId", label: t("appId"), hint: t("appIdHint"), value: value("appId"), placeholder: t("appIdPlaceholder"), disabled, onEdit: edit("appId"), mask: true }),
            jsx(SecretField, { state, onEdit: props.editSecret, t, disabled }),
          ] }),
        ] }, "connection"),
        jsx(Section, { number: "02", title: t("workspace"), hint: t("workspaceHint"), children: [
          jsx(WorkspacePicker, { state, value: value("defaultPath"), onEdit: edit("defaultPath"), onBrowse: props.listDirectory, onCreateDirectory: props.createDirectory, t, disabled }),
          state.catalog.status === "error" ? jsxs("div", { className: "cl-catalog-error", children: [t("catalogError"), jsx("button", { className: "cl-retry", type: "button", onClick: props.refreshCatalog, children: t("retry") })] }) : null,
          jsx(ModelPicker, { state, value, edit, t, disabled }),
          jsx("div", { style: { marginTop: 18 }, children: jsx(PermissionPicker, { value: value("permissionPreset"), onEdit: edit("permissionPreset"), disabled }) }),
        ] }, "workspace"),
      ],
    }),
    guideOpen ? jsx(GuideDialog, { onClose: () => setGuideOpen(false), t }) : null,
  ] });
}

function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "connect-lark: dictionaries");
  const model = new LarkSettingsModel(ctx);
  ctx.effect(() => () => model.dispose(), "connect-lark: form subscription");
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject(
    "plugins.bundle.config",
    () => ctx.slots.register({
      name: "plugins.bundle.config", key: PACKAGE, locale: NS,
      inject: () => model.inject(),
    }, LarkConfigCard),
  )), "connect-lark: settings page");
}
