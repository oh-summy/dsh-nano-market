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
  domain: "接入域名",
  connectionHint: "只需应用信息，国内和海外可以随时切换。",
  workspace: "工作区与模型",
  workspaceHint: "默认沿用 DSH 当前的工作方式，需要时再覆盖。",
  feishu: "飞书 · 国内",
  lark: "Lark · 海外",
  appId: "App ID",
  appIdHint: "应用信息仅保存在本机 DSH 配置中，页面默认掩码显示。",
  defaultPath: "默认工作区",
  defaultPathHint: "从 DSH 工作区中选择；右侧按钮可挑其他目录。",
  addWorkspace: "添加工作区",
  customPath: "自定义目录",
  model: "模型",
  modelHint: "默认使用 DSH 新会话的模型；只有需要时才单独覆盖。",
  reasoningEffort: "思考强度",
  reasoningEffortHint: "默认使用 DSH 新会话的思考强度。",
  followDsh: "跟随 DSH 当前配置",
  followModel: "跟随模型默认",
  searchModels: "搜索模型或提供方…",
  noModels: "没有匹配的模型",
  catalogError: "模型列表暂时不可用，仍可跟随 DSH 当前配置。",
  retry: "重试",
  save: "保存更改",
  saving: "保存中…",
  saveFailed: "配置未保存，请检查字段后重试。",
  readOnly: "当前部署的配置为只读。",
  unavailable: "connect-lark 未运行，暂时无法配置。",
  appIdPlaceholder: "cli_xxxxxxxx",
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
  guideJsonLabel: "最小权限清单",
  guideNote: "这是一份最小配置清单，不是密钥；可以复制给应用管理员核对。",
  access: "访问控制",
  accessHint: "谁可以给这个机器人发消息。默认只允许你授权的用户，避免其他人驱动本机 Agent。",
  accessApp: "跟随应用权限",
  accessAppHint: "谁能私聊机器人由飞书应用的「可用范围」决定，插件不再额外限制，也无需填任何 id。群聊仍需 @ 机器人，群成员不受此限制——要收紧群请改用「指定人员可用」。",
  accessList: "指定人员可用",
  accessListHint: "只允许名单里的人私聊、名单里的群发消息，租户管理员始终可用。",
  pickUser: "搜索要授权的人或群",
  pickUserHint: "输入姓名、open_id 或群名，搜到的结果点一下就加入授权名单。",
  searchPlaceholder: "搜索姓名 / open_id / 群名…",
  loadingUsers: "正在读取通讯录…",
  noUsers: "没有匹配的人或群",
  directoryUnavailable: "读不到飞书通讯录——可能是应用没有通讯录权限，或本机 9092 端口的目录服务没启动。",
  useManager: "用管理员",
  managerPrefix: "管理员",
  selectedUser: "已选",
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
  { path: "accessMode", kind: "choice", choices: ["app", "list"] },
  { path: "openId", kind: "text" },
  { path: "senderAllowlist", kind: "list" },
  { path: "groupAllowlist", kind: "list" },
  { path: "defaultPath", kind: "text" },
  { path: "provider", kind: "text" },
  { path: "model", kind: "text" },
  { path: "reasoningEffort", kind: "text" },
  { path: "permissionPreset", kind: "text" },
];

/**
 * 把一个人加入授权名单（文本语义：换行分隔）。
 * 纯函数，便于测试；调用方负责写回表单字段。
 */
/** 名单字段是换行分隔的文本；读出来是数组。 */
function readList(text) {
  return String(text || "").split("\n").map((item) => item.trim()).filter(Boolean);
}

function grantToList(currentText, openId) {
  const list = String(currentText || "").split("\n").map((item) => item.trim()).filter(Boolean);
  return (list.includes(openId) ? list : [...list, openId]).join("\n");
}

function definition(field) {
  const base = P.settingsTextField(field.path);
  return {
    ...base,
    // 暴露 choices，让测试能断言 UI 写入的值都在合法集合里。
    ...(field.choices ? { choices: field.choices } : {}),
    parse(text) {
      if (field.kind === "choice") {
        // 旧值（open / restricted）归一到新的两态，避免历史配置被判为非法。
        const legacy = { open: "app", restricted: "list" };
        const value = legacy[text] ?? text;
        return field.choices.includes(value) ? { kind: "set", value } : undefined;
      }
      if (field.kind === "list") {
        const value = text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
        return value.length === 0 ? { kind: "clear" } : { kind: "set", value };
      }
      const value = text.trim();
      return value === "" ? { kind: "clear" } : { kind: "set", value };
    },
    format(value) {
      // Array values (from senderAllowlist/groupAllowlist) must render as text
      // so the UI shows existing grants instead of blank inputs.
      if (field.kind === "list" && Array.isArray(value)) return value.join("\n");
      return base.format ? base.format(value) : value;
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
    this.form.actions().edit("appSecretPreview", value.slice(0, Math.min(5, value.length)));
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
.cl-wrap{--cl-blue:#3370ff;--cl-ink:var(--dsw-alias-label-primary,#1f2329);--cl-muted:var(--dsw-alias-label-secondary,#646a73);--cl-faint:var(--dsw-alias-label-tertiary,#8f959e);--cl-border:var(--dsw-alias-border-l3,#e5e7eb);--cl-border-strong:var(--dsw-alias-border-l4,#d8dde5);--cl-surface:var(--dsw-alias-bg-layer-2,#fff);--cl-surface-2:var(--dsw-alias-bg-layer-3,#fafbfc);--cl-hover:var(--dsw-alias-interactive-bg-hover,#f2f4f7);--cl-radius:12px;--cl-radius-lg:16px;--cl-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(16,24,40,.12));color:var(--cl-ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",sans-serif;max-width:780px;padding:2px 0 8px}
.cl-hero{border:1px solid var(--cl-border);border-radius:var(--cl-radius-lg);padding:22px 24px;background:var(--cl-surface);margin-bottom:18px}
.cl-hero-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.cl-hero h4{margin:0;font-size:20px;line-height:1.35;letter-spacing:-.02em;font-weight:680}
.cl-hero p{margin:8px 0 0;color:var(--cl-muted);font-size:13px;line-height:1.65;max-width:560px}
.cl-status{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;color:var(--cl-blue);background:color-mix(in srgb,var(--cl-blue) 10%,transparent);border-radius:999px;padding:6px 10px;font-size:11px;font-weight:600}
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
.cl-triple{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px}
.cl-triple>*{min-width:0}
@media(max-width:900px){.cl-triple{grid-template-columns:1fr}}
.cl-segment-inline{display:inline-grid;grid-auto-flow:column;grid-auto-columns:max-content;gap:2px;background:var(--cl-hover);border:1px solid #eef0f3;border-radius:9px;padding:3px}
.cl-segment-inline button{border:0;border-radius:7px;background:transparent;padding:7px 18px;font:inherit;font-size:12.5px;font-weight:500;color:var(--cl-muted);cursor:pointer;transition:background .12s,color .12s,box-shadow .12s;white-space:nowrap}
.cl-segment-inline button:hover:not(:disabled){color:#1f2329}
.cl-segment-inline button[aria-checked="true"]{background:#fff;color:#1f2329;font-weight:600;box-shadow:0 1px 3px rgba(31,35,41,.08)}
.cl-segment-inline button:disabled{opacity:.5;cursor:not-allowed}
.cl-field{min-width:0;margin-bottom:16px}
.cl-field:last-child{margin-bottom:0}
.cl-label{display:block;font-size:11.5px;font-weight:600;margin-bottom:6px;color:var(--cl-muted);letter-spacing:.01em}
.cl-input,.cl-picker-trigger,.cl-textarea{box-sizing:border-box;width:100%;border:1px solid var(--cl-border-strong);border-radius:var(--cl-radius);background:#fff;color:var(--cl-ink);padding:9px 11px;font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.cl-textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.cl-input:focus,.cl-picker-trigger:focus-visible,.cl-textarea:focus,.cl-segment button:focus-visible{outline:none;border-color:var(--cl-blue);box-shadow:0 0 0 3px rgba(51,112,255,.12)}
.cl-input:disabled,.cl-picker-trigger:disabled,.cl-textarea:disabled{background:var(--cl-surface-2);color:var(--cl-faint)}
.cl-hint{margin:6px 0 0;color:var(--cl-faint);font-size:11px;line-height:1.55}
.cl-segment{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--cl-hover);border-radius:10px;padding:4px;margin-bottom:18px}
.cl-segment button{border:1px solid transparent;border-radius:7px;background:transparent;color:#5f6672;padding:8px 12px;font:inherit;font-size:12px;cursor:pointer}
.cl-segment button[aria-checked="true"]{background:#fff;color:var(--cl-blue);border-color:#cfdcff;box-shadow:0 1px 4px rgba(31,35,41,.06);font-weight:600}
.cl-workspace-field{margin-bottom:18px}
.cl-users{border:1px solid var(--cl-border);border-radius:var(--cl-radius);padding:14px 16px;background:var(--cl-surface-2);transition:border-color .15s}
.cl-users:hover{border-color:var(--cl-border-strong)}
.cl-users-label{font-size:12px;font-weight:600;color:#30343b;margin-bottom:9px;display:block}
.cl-users-head{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.cl-users-search{flex:1;min-width:0;border:1px solid #dde1e8;border-radius:8px;padding:8px 11px;font:inherit;font-size:13px;background:#fff;color:#1f2329;transition:border-color .12s,box-shadow .12s}
.cl-users-search:focus{outline:none;border-color:var(--cl-blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-blue) 18%,transparent)}
.cl-users-list{max-height:190px;overflow:auto;display:flex;flex-direction:column;gap:2px}
.cl-user{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;border-radius:8px;padding:9px 10px;font:inherit;font-size:13px;cursor:pointer;color:#1f2329;text-align:left;transition:background .12s}
.cl-user:hover:not(:disabled){background:color-mix(in srgb,var(--cl-blue) 8%,transparent)}
.cl-user:disabled{opacity:.6;cursor:not-allowed}
.cl-user-name{font-weight:550;display:block}
.cl-user-body{min-width:0;flex:1;text-align:left}
.cl-avatar{flex:0 0 auto;width:28px;height:28px;border-radius:8px;overflow:hidden;background:#eef2f8;display:flex;align-items:center;justify-content:center}
.cl-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.cl-avatar-text{font-size:12px;font-weight:600;color:#5b6472}
.cl-avatar-chat{background:color-mix(in srgb,#0e9384 12%,transparent)}
.cl-avatar-chat .cl-avatar-text{color:#0e9384}
.cl-user-id{font-size:11px;color:#9ca3af;font-family:ui-monospace,monospace}
.cl-user-badge{font-size:10px;background:#eef2ff;color:#4f46e5;border-radius:999px;padding:2px 7px;font-weight:600;flex-shrink:0}
.cl-user-picked{margin-left:auto;font-size:11px;color:#16a34a;font-weight:600;flex-shrink:0}
.cl-users-note{font-size:11.5px;color:#8b949e;line-height:1.65;margin:9px 0 0}
.cl-users-note.warn{color:#8a5a00;background:#fff8e8;border-radius:7px;padding:8px 10px;margin-top:10px}
.cl-path-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}
.cl-path-row .cl-picker-trigger{height:100%}
.cl-workspace-add{display:inline-flex;align-items:center;justify-content:center;width:38px;border:1px solid var(--cl-border-strong);border-radius:var(--cl-radius);background:#fff;color:var(--cl-muted);font:inherit;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.cl-workspace-add:hover:not(:disabled){background:#f5f7fa;border-color:#c9d2e0;color:var(--cl-blue)}

.cl-workspace-add:disabled{opacity:.45;cursor:not-allowed}
.cl-browser-modal{width:min(680px,100%)}
.cl-browser-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin:18px 0 12px}
.cl-browser-list{height:340px;overflow:auto;border:1px solid #e9ecf2;border-radius:12px;padding:6px;background:#fcfdfe}
.cl-browser-entry{display:block;width:100%;border:0;border-radius:7px;background:transparent;color:#374151;text-align:left;padding:8px 10px;font:inherit;font-size:12px;cursor:pointer}

.cl-browser-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}
.cl-browser-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cl-browser-create{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:14px}
@media(max-width:560px){.cl-browser-list{height:280px}.cl-browser-footer{align-items:flex-start;flex-direction:column}}
.cl-picker{position:relative;min-width:0}
.cl-picker-trigger{display:flex;align-items:center;gap:10px;text-align:left;cursor:pointer;min-height:52px;padding:9px 11px;border-radius:var(--cl-radius);background:var(--cl-surface-2);transition:background .12s,border-color .12s}
.cl-picker-trigger:hover:not(:disabled){background:var(--cl-hover)}
.cl-picker-trigger[aria-expanded="true"]{background:var(--cl-hover);border-color:var(--cl-border-strong)}
.cl-picker-text{min-width:0;flex:1}
.cl-picker-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px;letter-spacing:-.005em}
.cl-picker-sub{display:block;color:var(--cl-faint);font-size:10.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cl-chevron{color:var(--cl-faint);font-size:9px;flex-shrink:0;transition:transform .12s}
.cl-menu-shield{position:fixed;inset:0;z-index:60;background:transparent}
.cl-menu{position:absolute;z-index:61;left:0;right:0;top:calc(100% + 6px);background:var(--cl-surface);border:1px solid var(--cl-border);border-radius:var(--cl-radius);box-shadow:var(--cl-shadow);padding:6px;max-height:320px;overflow:auto;transform-origin:top left;animation:clMenuIn .14s ease}
.cl-search{box-sizing:border-box;width:100%;border:1px solid var(--cl-border-strong);border-radius:8px;padding:7px 9px;font:inherit;font-size:12.5px;outline:none;margin-bottom:6px;background:var(--cl-surface-2);color:var(--cl-ink)}
.cl-search:focus{border-color:var(--cl-blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-blue) 16%,transparent)}
.cl-group-label{padding:11px 9px 5px;color:var(--cl-faint);font-size:10px;font-weight:650;letter-spacing:.06em}
.cl-menu .cl-option:not(:first-child){border-top:1px solid color-mix(in srgb,var(--cl-border) 60%,transparent);border-top-left-radius:0;border-top-right-radius:0}
.cl-menu .cl-group-label:not(:first-child){border-top:1px solid var(--cl-border)}
.cl-option{display:flex;align-items:center;gap:9px;width:100%;border:0;border-radius:8px;background:transparent;text-align:left;padding:8px 9px;color:var(--cl-ink);font:inherit;font-size:13px;cursor:pointer;transition:background .1s}
.cl-option:hover{background:var(--cl-hover)}
.cl-option[aria-selected="true"]{background:color-mix(in srgb,var(--cl-blue) 9%,transparent);box-shadow:inset 2.5px 0 0 var(--cl-blue)}
.cl-option[aria-selected="true"] .cl-option-name{color:var(--cl-blue)}
.cl-option-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.cl-option-desc{color:var(--cl-faint);font-size:11px;line-height:1.4}
.cl-option-name{display:block;font-size:12px;font-weight:550}
.cl-option-desc{display:block;color:var(--cl-muted);font-size:10px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-empty{padding:18px;text-align:center;color:var(--cl-muted);font-size:12px}
.cl-catalog-error{display:flex;align-items:center;gap:10px;color:#8a5a00;background:#fff8e8;border-radius:8px;padding:8px 10px;font-size:11px;margin-bottom:12px}
.cl-retry{border:0;background:transparent;color:var(--cl-blue);font:inherit;font-weight:600;cursor:pointer;padding:2px}
.cl-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(14,18,26,.44);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(3px) saturate(120%)}
.cl-modal{width:min(600px,100%);max-height:min(760px,90vh);overflow:auto;background:var(--cl-surface);border:1px solid var(--cl-border);border-radius:var(--cl-radius-lg);box-shadow:var(--cl-shadow);padding:26px}
.cl-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.cl-modal h3{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.cl-modal-intro{margin:8px 0 20px;color:var(--cl-muted);font-size:12px;line-height:1.65}
.cl-close{border:0;background:transparent;color:var(--cl-faint);border-radius:50%;width:30px;height:30px;font-size:17px;line-height:1;font:inherit;cursor:pointer;flex-shrink:0;transition:background .12s,color .12s}
.cl-close:hover{background:var(--cl-hover);color:var(--cl-ink)}
.cl-steps{position:relative;margin:20px 0 22px;padding-left:2px}
.cl-step{position:relative;display:flex;gap:14px;padding:0 0 18px 0}
.cl-step:last-child{padding-bottom:0}
.cl-step::before{content:"";position:absolute;left:7px;top:22px;bottom:0;width:2px;background:linear-gradient(180deg,#d9e3fb,#eaeff8);border-radius:2px}
.cl-step:last-child::before{display:none}
.cl-step-node{position:relative;z-index:1;display:block;flex:0 0 auto;width:16px;height:16px;margin-top:3px;border-radius:5px;background:#fff;border:2px solid var(--cl-blue);box-shadow:0 1px 2px rgba(51,112,255,.18)}
.cl-step-node::after{content:"";position:absolute;inset:3px;border-radius:2px;background:var(--cl-blue)}
.cl-step:first-child .cl-step-node{border-color:#1f6bff}
.cl-step-body{min-width:0}
.cl-step h4{margin:0 0 4px;font-size:13.5px;font-weight:600;letter-spacing:-.005em}
.cl-step p{margin:0;color:var(--cl-muted);font-size:12px;line-height:1.7}
.cl-code-label{display:block;margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a929e}
.cl-code{position:relative;background:#111826;color:#c9d6ea;border:1px solid #1d2942;border-left:3px solid var(--cl-blue);border-radius:12px;padding:16px 18px;font:11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.cl-modal-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;flex-wrap:wrap}
.cl-primary,.cl-secondary{display:inline-flex;align-items:center;justify-content:center;border-radius:8px;padding:9px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none}
.cl-primary{border:1px solid var(--cl-blue);background:var(--cl-blue);color:#fff}
.cl-secondary{border:1px solid #d8dde5;background:#fff;color:#374151}
.cl-modal-note{color:#4a5568;font-size:11.5px;margin:14px 0 0;line-height:1.65;padding:9px 12px;border-radius:9px;background:#f4f7fd;border:1px solid #e3ebfa;display:flex;gap:8px}
.cl-modal-note::before{content:"";flex:0 0 auto;width:5px;height:5px;margin-top:6px;border-radius:50%;background:var(--cl-blue);opacity:.55}
@media(max-width:560px){.cl-hero{padding:18px}.cl-hero-top{align-items:flex-start;flex-direction:column}.cl-card{padding:17px}.cl-status{white-space:normal}.cl-modal{padding:20px}.cl-section-head{flex-direction:column}.cl-guide-link{align-self:flex-start}}
@keyframes clMenuIn{from{opacity:0;transform:scaleY(.96) translateY(-3px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.cl-input,.cl-picker-trigger{transition:none}.cl-modal-backdrop{backdrop-filter:none}.cl-menu{animation:none}}
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

function ListField({ id, label, hint, value, placeholder, disabled, onEdit }) {
  return jsx(Field, { label, hint, children: jsx("textarea", {
    id, className: "cl-textarea", rows: 3, value: (Array.isArray(value.text) ? value.text.join("\n") : value.text) || "",
    placeholder, disabled, onChange: (event) => onEdit(event.target.value),
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

/** 模型 / 思考强度 / 权限模式并排一行；前两个共用一个展开状态，避免两个菜单同时打开。 */
function AgentRow({ state, value, edit, t, disabled }) {
  const [open, setOpen] = React.useState(null);
  return jsx("div", { className: "cl-triple", children: [
    jsx(ModelPicker, { state, value, edit, t, disabled, open, setOpen }),
    jsx(EffortPicker, { state, value, edit, t, disabled, open, setOpen }),
    jsx(PermissionPicker, { value: value("permissionPreset"), onEdit: edit("permissionPreset"), disabled, open, setOpen }),
  ] });
}

function ModelPicker({ state, value, edit, t, disabled, open, setOpen }) {
  const [query, setQuery] = React.useState("");
  const route = value("provider").text && value("model").text ? value("provider").text + "/" + value("model").text : "";
  const defaultRoute = state.catalog.default;
  const defaultName = defaultRoute ? modelName(state.catalog, defaultRoute.provider, defaultRoute.model) : "";
  const currentName = route ? modelName(state.catalog, value("provider").text, value("model").text) : t("followDsh");
  const filteredGroups = (state.catalog.groups || []).map((group) => ({
    ...group,
    models: group.models.filter((model) => (group.name + " " + model.name).toLowerCase().includes(query.trim().toLowerCase())),
  })).filter((group) => group.models.length > 0);
  const close = () => setOpen(null);
  const isOpen = open === "model";
  return jsx("div", { className: "cl-picker", children: [
    jsx("span", { className: "cl-label", children: t("model") }),
    jsxs("button", { type: "button", className: "cl-picker-trigger", disabled: disabled || state.catalog.status === "loading", onClick: () => setOpen(isOpen ? null : "model"), children: [
      jsxs("span", { className: "cl-picker-text", children: [
        jsx("span", { className: "cl-picker-title", children: currentName }),
        jsx("span", { className: "cl-picker-sub", children: route ? value("provider").text : defaultName ? "DSH 默认 · " + defaultName : t("followDsh") }),
      ] }),
      jsx("span", { className: "cl-chevron", children: isOpen ? "▲" : "▼" }),
    ] }),
    jsx("p", { className: "cl-hint", children: t("modelHint") }),
    isOpen ? jsxs(React.Fragment, { children: [
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
  ] });
}

function EffortPicker({ state, value, edit, t, disabled, open, setOpen }) {
  const selectedGroup = (state.catalog.groups || []).find((group) => group.id === value("provider").text);
  const selectedModel = selectedGroup ? selectedGroup.models.find((model) => model.id === value("model").text) : undefined;
  const efforts = (selectedModel && selectedModel.reasoning ? selectedModel.reasoning.efforts : []) || [];
  const currentEffort = value("reasoningEffort").text || t("followModel");
  const close = () => setOpen(null);
  const isOpen = open === "effort";
  return jsx("div", { className: "cl-picker", children: [
    jsx("span", { className: "cl-label", children: t("reasoningEffort") }),
    jsxs("button", { type: "button", className: "cl-picker-trigger", disabled: disabled || !selectedModel || !selectedModel.reasoning, onClick: () => setOpen(isOpen ? null : "effort"), children: [
      jsxs("span", { className: "cl-picker-text", children: [
        jsx("span", { className: "cl-picker-title", children: currentEffort }),
        jsx("span", { className: "cl-picker-sub", children: selectedModel ? selectedModel.name : t("followDsh") }),
      ] }),
      jsx("span", { className: "cl-chevron", children: isOpen ? "▲" : "▼" }),
    ] }),
    jsx("p", { className: "cl-hint", children: t("reasoningEffortHint") }),
    isOpen ? jsxs(React.Fragment, { children: [
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
  ] });
}

const PERMISSION_OPTIONS = [
  { value: "", label: "跟随 DSH 默认", description: "使用 DSH 当前的权限配置，不单独覆盖。" },
  { value: "read-only", label: "仅可查看", description: "只读取和分析，不修改文件或执行写操作。" },
  { value: "workspace-write", label: "工作区内修改", description: "允许修改当前工作区，敏感操作仍需要确认。" },
  { value: "danger-full-access", label: "完全权限", description: "直接执行更多操作，请只在你信任的任务中使用。" },
  { value: "auto", label: "自动审查", description: "每次工具调用前由模型审查，可能消耗额外 token。" },
];

function PermissionPicker({ value, onEdit, disabled, open, setOpen }) {
  const current = PERMISSION_OPTIONS.find((option) => option.value === value.text) || PERMISSION_OPTIONS[0];
  const isOpen = open === "permission";
  const close = () => setOpen(null);
  return jsxs("div", { className: "cl-picker", children: [
    jsx("span", { className: "cl-label", children: "权限模式" }),
    jsxs("button", { type: "button", className: "cl-picker-trigger", disabled, onClick: () => setOpen(isOpen ? null : "permission"), children: [
      jsxs("span", { className: "cl-picker-text", children: [
        jsx("span", { className: "cl-picker-title", children: current.label }),
        jsx("span", { className: "cl-picker-sub", children: current.description }),
      ] }),
      jsx("span", { className: "cl-chevron", children: isOpen ? "▲" : "▼" }),
    ] }),
    jsx("p", { className: "cl-hint", children: "控制机器人可以读取、修改或执行哪些操作。" }),
    isOpen ? jsxs(React.Fragment, { children: [
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
        type: "button", className: "cl-browser-entry", onClick: () => load(entry.path), children: jsxs("span", { children: [jsx("span", { className: "cl-browser-entry-mark", children: "▸" }), jsx("span", { children: entry.name })] }),
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
  const [menu, setMenu] = React.useState(false);
  const items = state.workspaces?.items || [];
  const current = value.text;
  const currentItem = items.find((item) => item.path === current);
  const currentTitle = currentItem ? currentItem.title : current || t("followDsh");
  const AddIcon = P.IconAppsAddOutlineRegular;
  const options = [
    { path: "", title: t("followDsh"), sub: t("defaultPathHint") },
  ].concat(
    current && !items.some((item) => item.path === current)
      ? [{ path: current, title: current, sub: t("customPath") }]
      : [],
    items.map((item) => ({ path: item.path, title: item.title, sub: item.path })),
  );
  const optionRows = options.map((option) => jsx("button", {
    className: "cl-option",
    role: "option",
    "aria-selected": option.path === current,
    key: option.path || "__follow",
    onClick: () => { onEdit(option.path); setMenu(false); },
    children: jsxs("span", { className: "cl-option-text", children: [
      jsx("span", { className: "cl-option-name", children: option.title }),
      option.sub ? jsx("span", { className: "cl-option-desc", children: option.sub }) : null,
    ] }),
  }, option.path || "__follow"));
  const trigger = jsxs("button", { type: "button", className: "cl-picker-trigger", disabled, onClick: () => setMenu(!menu), children: [
    jsxs("span", { className: "cl-picker-text", children: [
      jsx("span", { className: "cl-picker-title", children: currentTitle }),
      jsx("span", { className: "cl-picker-sub", children: current || t("followDsh") }),
    ] }),
    jsx("span", { className: "cl-chevron", children: menu ? "▲" : "▼" }),
  ] });
  const menuBox = menu ? jsx("div", { className: "cl-menu", role: "listbox", children: optionRows }) : null;
  const shield = menu ? jsx("div", { className: "cl-menu-shield", onClick: () => setMenu(false) }) : null;
  return jsxs("div", { children: [
    jsxs("div", { className: "cl-workspace-field", children: [
      jsx("span", { className: "cl-label", children: t("defaultPath") }),
      jsxs("div", { className: "cl-path-row", children: [
        jsx("div", { className: "cl-picker", children: [trigger, shield, menuBox] }),
        jsx("button", {
          type: "button",
          className: "cl-workspace-add",
          disabled,
          title: t("addWorkspace"),
          "aria-label": t("addWorkspace"),
          onClick: () => setOpen(true),
          children: jsx(AddIcon, { size: 15 }),
        }),
      ] }),
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
      jsx("div", { className: "cl-steps", children: [
        [
          [t("guideStep1"), t("guideStep1Text")],
          [t("guideStep2"), t("guideStep2Text")],
          [t("guideStep3"), t("guideStep3Text")],
        ].map(([title, text]) => jsxs("div", { className: "cl-step", children: [
          jsx("span", { className: "cl-step-node", "aria-hidden": "true" }),
          jsxs("div", { className: "cl-step-body", children: [jsx("h4", { children: title }), jsx("p", { children: text })] }),
        ] }, title)),
      ] }),
      jsx("span", { className: "cl-code-label", children: t("guideJsonLabel") }),
      jsx("pre", { className: "cl-code", children: GUIDE_JSON }),
      jsxs("div", { className: "cl-modal-actions", children: [
        jsx("a", { className: "cl-primary", href: "https://open.feishu.cn/app", target: "_blank", rel: "noreferrer", children: t("guideOpen") + " ↗" }),
        jsx("button", { className: "cl-secondary", type: "button", onClick: copy, children: copied ? t("guideCopied") + " ✓" : t("guideCopy") }),
      ] }),
      jsx("p", { className: "cl-modal-note", children: t("guideNote") }),
    ],
  }) });
}

/** 统一搜索：一个人、一个群、一个 id 都能搜到，命中即授权。 */
function DirectoryPicker({ value, onEdit, t, disabled }) {
  const [state, setState] = React.useState({ status: "idle", users: [], chats: [], manager: null, reason: "" });
  const [query, setQuery] = React.useState("");

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const response = await fetch("http://127.0.0.1:9092/lark-api/directory", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      if (body && body.ok) {
        setState({ status: "ready", users: body.users || [], chats: body.chats || [], manager: body.manager || null, reason: "" });
        return;
      }
      setState({ status: "unavailable", users: [], chats: [], manager: null, reason: (body && body.reason) || "directory unavailable" });
    } catch (error) {
      setState({ status: "unavailable", users: [], chats: [], manager: null, reason: (error && error.message) || "directory unavailable" });
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const grantedUsers = readList(value("senderAllowlist").text);
  const grantedChats = readList(value("groupAllowlist").text);

  const grantUser = (user) => {
    onEdit("senderAllowlist")(grantToList(value("senderAllowlist").text, user.openId));
  };
  const grantChat = (chat) => {
    onEdit("groupAllowlist")(grantToList(value("groupAllowlist").text, chat.chatId));
  };

  const needle = query.trim().toLowerCase();
  const users = state.users.filter((user) =>
    !needle || user.name.toLowerCase().includes(needle) || user.openId.toLowerCase().includes(needle));
  const chats = state.chats.filter((chat) =>
    !needle || chat.name.toLowerCase().includes(needle) || chat.chatId.toLowerCase().includes(needle));

  const head = jsxs("div", { className: "cl-users-head", children: [
    jsx("input", {
      className: "cl-users-search",
      value: query,
      placeholder: t("searchPlaceholder"),
      disabled: disabled || state.status !== "ready",
      onChange: (event) => setQuery(event.target.value),
    }),
    state.manager
      ? jsx("button", {
          type: "button",
          className: "cl-btn",
          disabled,
          onClick: () => grantUser(state.manager),
          children: t("useManager"),
        })
      : null,
  ] });

  const body = state.status === "loading"
    ? jsx("div", { className: "cl-users-note" }, t("loadingUsers"))
    : state.status === "unavailable"
      ? jsx("div", { className: "cl-users-note warn" }, t("directoryUnavailable"))
      : users.length === 0 && chats.length === 0
        ? jsx("div", { className: "cl-users-note" }, t("noUsers"))
        : jsxs("div", { className: "cl-users-list", children: [
            ...users.map((user) => jsx("button", {
              type: "button",
              className: "cl-user",
              key: "u:" + user.openId,
              disabled,
              onClick: () => grantUser(user),
              children: [
                jsx("span", { className: "cl-avatar", children: user.avatar
                  ? jsx("img", { src: user.avatar, alt: "" })
                  : jsx("span", { className: "cl-avatar-text", children: user.name.slice(0, 1) })
                }),
                jsx("span", { className: "cl-user-body", children: [
                  jsx("span", { className: "cl-user-name", children: user.name }),
                  jsx("span", { className: "cl-user-id", children: user.openId }),
                ] }),
                user.isManager ? jsx("span", { className: "cl-user-badge", children: t("managerPrefix") }) : null,
                grantedUsers.includes(user.openId) ? jsx("span", { className: "cl-user-picked", children: t("selectedUser") }) : null,
              ],
            }, user.openId)),
            ...chats.map((chat) => jsx("button", {
              type: "button",
              className: "cl-user",
              key: "c:" + chat.chatId,
              disabled,
              onClick: () => grantChat(chat),
              children: [
                jsx("span", { className: "cl-avatar cl-avatar-chat", children: chat.avatar
                  ? jsx("img", { src: chat.avatar, alt: "" })
                  : jsx("span", { className: "cl-avatar-text", children: chat.name.slice(0, 1) })
                }),
                jsx("span", { className: "cl-user-body", children: [
                  jsx("span", { className: "cl-user-name", children: chat.name }),
                  jsx("span", { className: "cl-user-id", children: chat.chatId }),
                ] }),
                grantedChats.includes(chat.chatId) ? jsx("span", { className: "cl-user-picked", children: t("selectedUser") }) : null,
              ],
            }, chat.chatId)),
          ] });

  return jsx("div", {
    className: "cl-users",
    children: [
      jsx("span", { className: "cl-users-label", children: t("pickUser") }),
      head,
      body,
      jsx("p", { className: "cl-users-note", children: t("pickUserHint") }),
    ],
  });
}
function AccessPicker({ value, onEdit, t, disabled }) {
  const mode = value("accessMode").text || "app";
  // "app" and the legacy "open" both mean: defer to the Feishu app scope.
  const isAppScope = mode === "app" || mode === "open";
  const modes = [
    { id: "app", label: t("accessApp") },
    { id: "list", label: t("accessList") },
  ];
  return jsx("div", {
    children: [
      jsx("div", { className: "cl-segment-inline", role: "radiogroup", "aria-label": t("access"), children: modes.map((modeItem) => jsx("button", {
        type: "button",
        role: "radio",
        "aria-checked": (mode === "app" || mode === "open") === (modeItem.id === "app") || (mode === "list" || mode === "restricted") === (modeItem.id === "list"),
        disabled,
        onClick: () => { onEdit("accessMode")(modeItem.id); },
        children: modeItem.label,
      }, modeItem.id)) }),
      jsx("p", { className: "cl-hint", children: isAppScope ? t("accessAppHint") : t("accessListHint") }),
      isAppScope
        ? null
        : jsx(DirectoryPicker, { value, onEdit, t, disabled }),
    ],
  });
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
        jsx(Section, { number: "02", title: t("access"), hint: t("accessHint"), children: [
          jsx(AccessPicker, { value, onEdit: edit, t, disabled }),
        ] }, "access"),
        jsx(Section, { number: "03", title: t("workspace"), hint: t("workspaceHint"), children: [
          jsx(WorkspacePicker, { state, value: value("defaultPath"), onEdit: edit("defaultPath"), onBrowse: props.listDirectory, onCreateDirectory: props.createDirectory, t, disabled }),
          state.catalog.status === "error" ? jsxs("div", { className: "cl-catalog-error", children: [t("catalogError"), jsx("button", { className: "cl-retry", type: "button", onClick: props.refreshCatalog, children: t("retry") })] }) : null,
          jsx(AgentRow, { state, value, edit, t, disabled }),
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
