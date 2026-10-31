// Native settings page for @oh-summy/connect-lark.
const { jsx, jsxs } = require("react/jsx-runtime");
const P = require("@deepseek-ai/dsh-client-ui-primitives");
const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

const NS = "connect-lark.settings";
const PACKAGE = "@oh-summy/connect-lark";
const ENTRY = "connect-lark";
// "remote.credentials" 必须显式声明：带点键是字面服务名，不声明则 saveSecret 里
// ctx.remote.credentials.set 抛 "cannot get property ... without inject"（宿主 cordis 语义）。
const inject = ["slots", "locale", "remote", "remote.session", "remote.directoryPicker", "remote.credentials", "workspaces", "configForms"];

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
  appName: "飞书",
  appId: "App ID",
  appIdHint: "应用信息仅保存在本机 DSH 配置中，页面默认掩码显示。",
  reveal: "显示 App ID 明文",
  hide: "隐藏 App ID 明文",
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
  secretHint: "完整 Secret 只存进 DSH 凭据缝；这里只写新值，旧值不会回显。",
  secretConfigured: "已配置",
  secretNotSet: "未配置",
  secretReplace: "已配置，粘贴新值即覆盖",
  statusPending: "有未保存的更改…",
  statusSaving: "保存中…",
  statusSaved: "已保存 ✓",
  statusFailed: "保存失败",
  dshDefault: "DSH 默认",
  close: "关闭",
  cancel: "取消",
  browserTitle: "选择工作区目录",
  browserHome: "主目录",
  browserPathLabel: "目录路径",
  browserLoading: "正在读取目录…",
  browserNewFolder: "新建文件夹",
  browserFolderName: "文件夹名称",
  browserCreate: "创建",
  browserOpen: "打开",
  browserShowHidden: "显示隐藏文件",
  browserHideHidden: "隐藏系统文件",
  browserTruncated: "文件夹过多，仅显示开头部分。",
  permissionLabel: "权限模式",
  permissionHint: "控制机器人可以读取、修改或执行哪些操作。",
  permissionFollow: "跟随 DSH 默认",
  permissionFollowDesc: "使用 DSH 当前的权限配置，不单独覆盖。",
  permissionReadOnly: "仅可查看",
  permissionReadOnlyDesc: "只读取和分析，不修改文件或执行写操作。",
  permissionWorkspaceWrite: "工作区内修改",
  permissionWorkspaceWriteDesc: "允许修改当前工作区，敏感操作仍需要确认。",
  permissionFullAccess: "完全权限",
  permissionFullAccessDesc: "直接执行更多操作，请只在你信任的任务中使用。",
  permissionAuto: "自动审查",
  permissionAutoDesc: "每次工具调用前由模型审查，可能消耗额外 token。",
  guideCapability: "机器人",
  guideConnection: "WebSocket 长连接",
};
const en = {
  heroTitle: "Hand Feishu messages to DSH",
  heroDescription: "Once the app is connected, direct messages and group chats reach the DSH workspace you pick.",
  heroStatus: "Connects automatically when enabled",
  connection: "Connect Feishu",
  domain: "Endpoint",
  connectionHint: "Only app credentials are needed; switch between CN and overseas anytime.",
  workspace: "Workspace & model",
  workspaceHint: "Follows how DSH currently works by default; override only when needed.",
  feishu: "Feishu · China",
  lark: "Lark · Global",
  appName: "Feishu",
  appId: "App ID",
  appIdHint: "App credentials stay in local DSH config; the page masks them by default.",
  reveal: "Show App ID",
  hide: "Hide App ID",
  defaultPath: "Default workspace",
  defaultPathHint: "Pick from DSH workspaces; the button on the right browses for another folder.",
  addWorkspace: "Add workspace",
  customPath: "Custom folder",
  model: "Model",
  modelHint: "Uses DSH's model for new sessions by default; override only when needed.",
  reasoningEffort: "Reasoning effort",
  reasoningEffortHint: "Uses DSH's reasoning effort for new sessions by default.",
  followDsh: "Follow DSH",
  followModel: "Follow model default",
  searchModels: "Search models or providers…",
  noModels: "No matching models",
  catalogError: "The model list is unavailable; you can still follow DSH's current configuration.",
  retry: "Retry",
  save: "Save changes",
  saving: "Saving…",
  saveFailed: "Changes were not saved; check the fields and try again.",
  readOnly: "The configuration on this deployment is read-only.",
  unavailable: "connect-lark is not running, so it cannot be configured right now.",
  appIdPlaceholder: "cli_xxxxxxxx",
  guideButton: "Create the app & permissions",
  guideTitle: "Create a Feishu app",
  guideIntro: "Complete these steps on the Feishu open platform, then come back to fill in the app credentials.",
  guideStep1: "Create a custom app",
  guideStep1Text: "Open the Feishu open platform, create a custom enterprise app, and find the App ID and App Secret under \"Credentials & basic info\".",
  guideStep2: "Enable bot capability",
  guideStep2Text: "Add the bot capability under \"App capabilities\". Whether direct chats work is decided by the Feishu app's own availability settings.",
  guideStep3: "Configure permissions & events",
  guideStep3Text: "Enable the permissions below under \"Permissions\"; under \"Events\" choose the WebSocket long connection and add the message-receive event.",
  guideOpen: "Open the Feishu open platform",
  guideCopy: "Copy the checklist",
  guideCopied: "Copied",
  guideClose: "Close",
  guideJsonLabel: "Minimal permission checklist",
  guideNote: "This is a minimal configuration checklist, not a secret; share it with your app admin to double-check.",
  guideCapability: "bot",
  guideConnection: "WebSocket long connection",
  access: "Access control",
  accessHint: "Who may message this bot. Only users you authorize are allowed by default, so nobody else can drive the local agent.",
  accessApp: "Follow app scope",
  accessAppHint: "Who can DM the bot is decided by the Feishu app's availability scope; the plugin adds no extra restriction and needs no ids. Group chats still require @-mentioning the bot, and group members are not limited by this — tighten groups with \"Specific people\" instead.",
  accessList: "Specific people",
  accessListHint: "Only people on the list may DM, and only listed groups may chat; the tenant manager always can.",
  pickUser: "People & groups to authorize",
  pickUserHint: "Search by name, open_id, or group name; a click on a result adds it to the allowlist.",
  searchPlaceholder: "Search names / open_id / groups…",
  loadingUsers: "Reading the directory…",
  noUsers: "No matching people or groups",
  directoryUnavailable: "The Feishu directory cannot be read — the app may lack directory permission, or the directory service on local port 9092 is not running.",
  useManager: "Use manager",
  managerPrefix: "Manager",
  selectedUser: "Selected",
  secretHint: "The full secret is stored only in the DSH credential vault; type a new value here — existing values are never shown back.",
  secretConfigured: "Configured",
  secretNotSet: "Not set",
  secretReplace: "Configured — paste a new value to replace",
  statusPending: "Unsaved changes…",
  statusSaving: "Saving…",
  statusSaved: "Saved ✓",
  statusFailed: "Save failed",
  dshDefault: "DSH default",
  close: "Close",
  cancel: "Cancel",
  browserTitle: "Choose a workspace folder",
  browserHome: "Home",
  browserPathLabel: "Folder path",
  browserLoading: "Reading the folder…",
  browserNewFolder: "New folder",
  browserFolderName: "Folder name",
  browserCreate: "Create",
  browserOpen: "Open",
  browserShowHidden: "Show hidden files",
  browserHideHidden: "Hide hidden files",
  browserTruncated: "Too many folders; only the beginning is shown.",
  permissionLabel: "Permission mode",
  permissionHint: "Controls what the bot may read, modify, or run.",
  permissionFollow: "Follow DSH default",
  permissionFollowDesc: "Uses DSH's current permission settings without an override.",
  permissionReadOnly: "Read-only",
  permissionReadOnlyDesc: "Reads and analyzes only; no file changes or write operations.",
  permissionWorkspaceWrite: "Workspace writes",
  permissionWorkspaceWriteDesc: "May modify the current workspace; sensitive operations still ask for confirmation.",
  permissionFullAccess: "Full access",
  permissionFullAccessDesc: "Runs more operations directly; use only with tasks you trust.",
  permissionAuto: "Auto review",
  permissionAutoDesc: "The model reviews every tool call first, which may cost extra tokens.",
};

// 最小权限清单随界面语言生成；权限与事件 id 本身是开放平台的英文标识。
function guideJson(t) {
  return JSON.stringify({
    capability: t("guideCapability"),
    permissions: ["im:message", "im:message:send_as_bot", "im:resource"],
    event: "im.message.receive_v1",
    connection: t("guideConnection"),
  }, null, 2);
}

// client 测试沙箱里可能没有 node 全局定时器：防御式取用（退化为立即执行）
const deferFn = (fn, ms) => (typeof setTimeout === "function" ? setTimeout(fn, ms) : (fn(), undefined));
const cancelFn = (t) => (typeof clearTimeout === "function" ? clearTimeout(t) : undefined);

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
    this.saveTimer = null;
    this.saveStatus = "idle"; // idle | pending | saving | saved | error
    this.saveError = "";
    this.loadCatalog();
  }
  projection() {
    const snapshot = this.formState.getSnapshot();
    return { ...snapshot, dirty: snapshot.dirty || this.secretDraft.length > 0, secretDraft: this.secretDraft, catalog: this.catalog, workspaces: this.workspaces.list.getSnapshot(),
      saveStatus: this.saveStatus, saveError: this.saveError };
  }
  publish() { this.store.set(this.projection()); }
  /** 自动保存：最后一次改动 700ms 后落盘；连续编辑只保留最后一次。 */
  scheduleSave() {
    this.saveStatus = "pending";
    this.publish();
    if (this.saveTimer != null) cancelFn(this.saveTimer);
    this.saveTimer = deferFn(() => { this.saveTimer = null; void this.runSave(); }, 700);
  }
  async runSave() {
    this.saveStatus = "saving";
    this.publish();
    try {
      if (this.secretDraft) await this.saveSecret(this.secretDraft);
      const result = await this.form.actions().save();
      if (result && result.ok === false) throw new Error(result.error?.message || "save failed");
      this.saveStatus = "saved";
      this.saveError = "";
    } catch (error) {
      this.saveStatus = "error";
      this.saveError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
    if (this.saveStatus === "saved") {
      // 「已保存 ✓」短暂驻留后回到安静态
      deferFn(() => { if (this.saveStatus === "saved") { this.saveStatus = "idle"; this.publish(); } }, 2200);
    }
  }
  /** 同步保存入口（错误提示里的「重试」也走这里）。 */
  save() { this.scheduleSave(); return this.projection(); }
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
  inject() {
    return {
      hooks: { larkSettings: this.store },
      ...this.form.actions(),
      // 字段级编辑统一挂自动保存：选择器、输入框失焦、Secret 草稿都走同一条防抖落盘路径
      edit: (path, text) => { this.form.actions().edit(path, text); this.scheduleSave(); },
      save: () => this.scheduleSave(),
      refreshCatalog: () => this.loadCatalog(),
      listDirectory: (path) => this.listDirectory(path),
      createDirectory: (path, name) => this.createDirectory(path, name),
      saveSecret: (value) => this.saveSecret(value),
      editSecret: (text) => { this.secretDraft = text; this.publish(); this.scheduleSave(); },
    };
  }
  dispose() {
    if (this.saveTimer != null) cancelFn(this.saveTimer);
    this.unsubscribe?.();
    this.unsubscribeWorkspaces?.();
    this.form.dispose();
  }
}

const styles = `
/* 颜色一律走宿主令牌（--dsw-*），品牌蓝（--cl-blue）与凭据缝文案除外；
   字面量只允许出现在 fallback 里，暗色主题下跟着宿主走。 */
.cl-wrap{--cl-blue:#3370ff;--cl-ink:var(--dsw-alias-label-primary,#1f2329);--cl-muted:var(--dsw-alias-label-secondary,#646a73);--cl-faint:var(--dsw-alias-label-tertiary,#8f959e);--cl-border:var(--dsw-alias-border-l3,#e5e7eb);--cl-border-strong:var(--dsw-alias-border-l4,#d8dde5);--cl-surface:var(--dsw-alias-bg-layer-2,#fff);--cl-surface-2:var(--dsw-alias-bg-layer-3,#fafbfc);--cl-hover:var(--dsw-alias-interactive-bg-hover,#f2f4f7);--cl-radius:12px;--cl-radius-lg:16px;--cl-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(16,24,40,.12));--cl-soft:var(--dsw-elevation-soft,0 1px 3px rgba(16,24,40,.08));--cl-warn:var(--dsw-alias-state-warn-primary,#8a5a00);--cl-ok:var(--dsw-alias-state-success-primary,#16a34a);color:var(--cl-ink);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",sans-serif);max-width:780px;padding:2px 0 8px}
.cl-hero{border:1px solid var(--cl-border);border-radius:var(--cl-radius-lg);padding:22px 24px;background:var(--cl-surface);margin-bottom:18px}
.cl-hero-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.cl-hero h4{margin:0;font-size:20px;line-height:1.35;letter-spacing:-.02em;font-weight:680}
.cl-hero p{margin:8px 0 0;color:var(--cl-muted);font-size:13px;line-height:1.65;max-width:560px}
.cl-status{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;color:var(--cl-blue);background:color-mix(in srgb,var(--cl-blue) 10%,transparent);border-radius:999px;padding:6px 10px;font-size:11px;font-weight:600}
.cl-status:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--cl-blue)}
.cl-path{display:flex;align-items:center;gap:10px;margin-top:18px;font-size:12px;color:var(--cl-muted)}
.cl-node{padding:6px 10px;border:1px solid var(--cl-border);background:var(--cl-surface-2);border-radius:8px}
.cl-arrow{color:var(--cl-faint);letter-spacing:2px}
.cl-card{border:1px solid var(--cl-border);border-radius:14px;background:var(--cl-surface);padding:20px 22px;margin-top:14px}
.cl-section{display:flex;gap:12px;align-items:flex-start;margin-bottom:18px}
.cl-number{display:inline-flex;align-items:center;justify-content:center;min-width:27px;height:22px;border-radius:6px;background:color-mix(in srgb,var(--cl-blue) 8%,transparent);color:var(--cl-blue);font-size:11px;font-weight:700;letter-spacing:.04em}
.cl-section h5{margin:1px 0 0;font-size:14px;font-weight:650}
.cl-section p{margin:5px 0 0;color:var(--cl-muted);font-size:12px;line-height:1.55}
.cl-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.cl-guide-link{border:0;background:transparent;color:var(--cl-blue);font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:2px 0;white-space:nowrap}
.cl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.cl-triple{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px}
.cl-triple>*{min-width:0}
@media(max-width:900px){.cl-triple{grid-template-columns:1fr}}
.cl-segment-inline{display:inline-grid;grid-auto-flow:column;grid-auto-columns:max-content;gap:2px;background:var(--cl-hover);border:1px solid var(--cl-border);border-radius:9px;padding:3px}
.cl-segment-inline button{border:0;border-radius:7px;background:transparent;padding:7px 18px;font:inherit;font-size:12.5px;font-weight:500;color:var(--cl-muted);cursor:pointer;transition:background .12s,color .12s,box-shadow .12s;white-space:nowrap}
.cl-segment-inline button:hover:not(:disabled){color:var(--cl-ink)}
.cl-segment-inline button[aria-checked="true"]{background:var(--cl-surface);color:var(--cl-ink);font-weight:600;box-shadow:var(--cl-soft)}
.cl-segment-inline button:disabled{opacity:.5;cursor:not-allowed}
.cl-field{min-width:0;margin-bottom:16px}
.cl-field:last-child{margin-bottom:0}
.cl-label{font-size:12px;font-weight:600;color:var(--cl-muted);letter-spacing:.01em}
.cl-label-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.cl-label-row .cl-label{flex:1;min-width:0}
.cl-state-tag{flex:none;font-size:10.5px;font-weight:600;color:var(--cl-muted);background:var(--cl-hover);border-radius:999px;padding:2px 8px}
.cl-state-tag.ok{color:var(--cl-ok);background:color-mix(in srgb,var(--cl-ok) 10%,transparent)}
.cl-savebar{margin:2px 0 0;font-size:12px;color:var(--cl-muted);text-align:right}
.cl-savebar.err{color:var(--cl-warn)}
.cl-input,.cl-picker-trigger,.cl-textarea{box-sizing:border-box;width:100%;border:1px solid var(--cl-border-strong);border-radius:var(--cl-radius);background:var(--cl-surface);color:var(--cl-ink);padding:9px 11px;font:inherit;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
.cl-textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.cl-input:focus,.cl-picker-trigger:focus-visible,.cl-textarea:focus,.cl-segment button:focus-visible{outline:none;border-color:var(--cl-blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-blue) 15%,transparent)}
.cl-input:disabled,.cl-picker-trigger:disabled,.cl-textarea:disabled{background:var(--cl-surface-2);color:var(--cl-faint)}
.cl-input-row{display:flex;align-items:center;gap:8px}
.cl-input-row .cl-input{flex:1;min-width:0}
.cl-eye{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--cl-border-strong);border-radius:8px;background:var(--cl-surface);color:var(--cl-muted);cursor:pointer;transition:color .12s,border-color .12s}
.cl-eye:hover:not(:disabled){color:var(--cl-blue);border-color:var(--cl-blue)}
.cl-eye:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.cl-eye:disabled{opacity:.45;cursor:not-allowed}
.cl-hint{margin:6px 0 0;color:var(--cl-faint);font-size:11px;line-height:1.55}
.cl-segment{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--cl-hover);border-radius:10px;padding:4px;margin-bottom:18px}
.cl-segment button{border:1px solid transparent;border-radius:7px;background:transparent;color:var(--cl-muted);padding:8px 12px;font:inherit;font-size:12px;cursor:pointer}
.cl-segment button[aria-checked="true"]{background:var(--cl-surface);color:var(--cl-blue);border-color:color-mix(in srgb,var(--cl-blue) 22%,transparent);box-shadow:var(--cl-soft);font-weight:600}
.cl-workspace-field{margin-bottom:18px}
.cl-users{border:1px solid var(--cl-border);border-radius:var(--cl-radius);padding:14px 16px;background:var(--cl-surface-2);transition:border-color .15s}
.cl-users:hover{border-color:var(--cl-border-strong)}
.cl-users-label{font-size:12px;font-weight:600;color:var(--cl-ink);margin-bottom:9px;display:block}
.cl-users-head{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.cl-users-search{flex:1;min-width:0;border:1px solid var(--cl-border-strong);border-radius:8px;padding:8px 11px;font:inherit;font-size:13px;background:var(--cl-surface);color:var(--cl-ink);transition:border-color .12s,box-shadow .12s}
.cl-users-search:focus{outline:none;border-color:var(--cl-blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-blue) 18%,transparent)}
.cl-users-list{max-height:190px;overflow:auto;display:flex;flex-direction:column;gap:2px}
.cl-user{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;border-radius:8px;padding:9px 10px;font:inherit;font-size:13px;cursor:pointer;color:var(--cl-ink);text-align:left;transition:background .12s}
.cl-user:hover:not(:disabled){background:color-mix(in srgb,var(--cl-blue) 8%,transparent)}
.cl-user:disabled{opacity:.6;cursor:not-allowed}
.cl-user-name{font-weight:550;display:block}
.cl-user-body{min-width:0;flex:1;text-align:left}
.cl-avatar{flex:0 0 auto;width:28px;height:28px;border-radius:8px;overflow:hidden;background:var(--cl-hover);display:flex;align-items:center;justify-content:center}
.cl-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.cl-avatar-text{font-size:12px;font-weight:600;color:var(--cl-muted)}
.cl-avatar-chat{background:color-mix(in srgb,var(--cl-ok) 12%,transparent)}
.cl-avatar-chat .cl-avatar-text{color:var(--cl-ok)}
.cl-user-id{font-size:11px;color:var(--cl-faint);font-family:ui-monospace,monospace}
.cl-user-badge{font-size:10px;background:color-mix(in srgb,var(--cl-blue) 10%,transparent);color:var(--cl-blue);border-radius:999px;padding:2px 7px;font-weight:600;flex-shrink:0}
.cl-user-picked{margin-left:auto;font-size:11px;color:var(--cl-ok);font-weight:600;flex-shrink:0}
.cl-users-note{font-size:11.5px;color:var(--cl-faint);line-height:1.65;margin:9px 0 0}
.cl-users-note.warn{color:var(--cl-warn);background:color-mix(in srgb,var(--cl-warn) 10%,transparent);border-radius:7px;padding:8px 10px;margin-top:10px}
.cl-path-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}
.cl-path-row .cl-picker-trigger{height:100%}
.cl-workspace-add{display:inline-flex;align-items:center;justify-content:center;width:38px;border:1px solid var(--cl-border-strong);border-radius:var(--cl-radius);background:var(--cl-surface);color:var(--cl-muted);font:inherit;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.cl-workspace-add:hover:not(:disabled){background:var(--cl-hover);border-color:var(--cl-border-strong);color:var(--cl-blue)}

.cl-workspace-add:disabled{opacity:.45;cursor:not-allowed}
.cl-browser-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin:0 0 12px}
.cl-browser-list{height:340px;overflow:auto;border:1px solid var(--cl-border);border-radius:12px;padding:6px;background:var(--cl-surface-2)}
.cl-browser-entry{display:block;width:100%;border:0;border-radius:7px;background:transparent;color:var(--cl-ink);text-align:left;padding:8px 10px;font:inherit;font-size:12px;cursor:pointer}

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
.cl-catalog-error{display:flex;align-items:center;gap:10px;color:var(--cl-warn);background:color-mix(in srgb,var(--cl-warn) 10%,transparent);border-radius:8px;padding:8px 10px;font-size:11px;margin-bottom:12px}
.cl-retry{border:0;background:transparent;color:var(--cl-blue);font:inherit;font-weight:600;cursor:pointer;padding:2px}
.cl-modal-intro{margin:0 0 20px;color:var(--cl-muted);font-size:12px;line-height:1.65}
.cl-steps{position:relative;margin:20px 0 22px;padding-left:2px}
.cl-step{position:relative;display:flex;gap:14px;padding:0 0 18px 0}
.cl-step:last-child{padding-bottom:0}
.cl-step::before{content:"";position:absolute;left:7px;top:22px;bottom:0;width:2px;background:linear-gradient(180deg,color-mix(in srgb,var(--cl-blue) 26%,transparent),color-mix(in srgb,var(--cl-blue) 8%,transparent));border-radius:2px}
.cl-step:last-child::before{display:none}
.cl-step-node{position:relative;z-index:1;display:block;flex:0 0 auto;width:16px;height:16px;margin-top:3px;border-radius:5px;background:var(--cl-surface);border:2px solid var(--cl-blue);box-shadow:0 1px 2px color-mix(in srgb,var(--cl-blue) 18%,transparent)}
.cl-step-node::after{content:"";position:absolute;inset:3px;border-radius:2px;background:var(--cl-blue)}
.cl-step-body{min-width:0}
.cl-step h4{margin:0 0 4px;font-size:13.5px;font-weight:600;letter-spacing:-.005em}
.cl-step p{margin:0;color:var(--cl-muted);font-size:12px;line-height:1.7}
.cl-code-label{display:block;margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--cl-faint)}
.cl-code{position:relative;background:#111826;color:#c9d6ea;border:1px solid #1d2942;border-left:3px solid var(--cl-blue);border-radius:12px;padding:16px 18px;font:11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.cl-modal-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;flex-wrap:wrap}
.cl-primary{display:inline-flex;align-items:center;justify-content:center;border-radius:8px;padding:9px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;border:1px solid var(--cl-blue);background:var(--cl-blue);color:#fff}
.cl-modal-note{color:var(--cl-muted);font-size:11.5px;margin:14px 0 0;line-height:1.65;padding:9px 12px;border-radius:9px;background:color-mix(in srgb,var(--cl-blue) 5%,transparent);border:1px solid color-mix(in srgb,var(--cl-blue) 14%,transparent);display:flex;gap:8px}
.cl-modal-note::before{content:"";flex:0 0 auto;width:5px;height:5px;margin-top:6px;border-radius:50%;background:var(--cl-blue);opacity:.55}
@media(max-width:560px){.cl-hero{padding:18px}.cl-hero-top{align-items:flex-start;flex-direction:column}.cl-card{padding:17px}.cl-status{white-space:normal}.cl-section-head{flex-direction:column}.cl-guide-link{align-self:flex-start}}
@keyframes clMenuIn{from{opacity:0;transform:scaleY(.96) translateY(-3px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.cl-input,.cl-picker-trigger{transition:none}.cl-menu{animation:none}}
`;

function Field({ label, badge, badgeTone, hint, children }) {
  return jsxs("div", { className: "cl-field", children: [
    jsxs("span", { className: "cl-label-row", children: [
      jsx("span", { className: "cl-label", children: label }),
      badge ? jsx("span", { className: "cl-state-tag" + (badgeTone === "ok" ? " ok" : ""), children: badge }) : null,
    ] }),
    children,
    hint ? jsx("p", { className: "cl-hint", children: hint }) : null,
  ] });
}

function TextField({ id, label, hint, value, placeholder, disabled, onEdit, mask = false, t }) {
  // 掩码语义（与 dsh-remote 的 maskedInput 同一族）：
  //   非编辑态：存量值默认掩码显示，点眼睛才明文（只读查看），失焦自动复掩；
  //   编辑态：聚焦即进入草稿模式（清空 + placeholder 指引），自由输入，失焦提交非空新值。
  // 聚焦不再自动明文；掩码串处于只读态，绝无机会被混进真值。
  const [draft, setDraft] = React.useState(undefined);
  const [revealed, setRevealed] = React.useState(false);
  const editing = draft !== undefined;
  const stored = value.text;
  const hidden = mask && !revealed && stored.length > 5;
  const shown = editing ? draft : hidden ? stored.slice(0, 5) + "•••••" : stored;
  return jsx(Field, { label, hint, children: jsxs("div", { className: "cl-input-row", children: [
    jsx("input", {
      id, className: "cl-input", value: shown, placeholder, disabled,
      readOnly: !editing,
      onFocus: () => { if (!editing) setDraft(""); },
      onChange: (event) => setDraft(event.target.value),
      onBlur: () => {
        const next = (draft ?? "").trim();
        if (next && next !== stored) onEdit(next);
        setDraft(undefined);
        setRevealed(false);
      },
    }),
    !editing && (hidden || revealed) ? jsx("button", {
      type: "button", className: "cl-eye", disabled,
      "aria-label": revealed ? t("hide") : t("reveal"),
      "aria-pressed": revealed,
      title: revealed ? t("hide") : t("reveal"),
      onClick: () => setRevealed(!revealed),
      children: revealed ? EyeOffIcon() : EyeIcon(),
    }) : null,
  ] }) });
}

function EyeIcon() {
  return jsxs("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    jsx("path", { d: "M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" }),
    jsx("circle", { cx: 12, cy: 12, r: 2.8 }),
  ] });
}

function EyeOffIcon() {
  return jsxs("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    jsx("path", { d: "M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" }),
    jsx("path", { d: "M4 4l16 16" }),
  ] });
}

function SecretField({ state, onEdit, t, disabled }) {
  const preview = state.fields.appSecretPreview.text;
  // 与 App ID 同一套 cl-* 排版（两列才能对齐）；只写不回显：空输入 + 徽标表达状态，
  // 真值走凭据缝（model.saveSecret），这里永远只拿草稿。
  return jsx(Field, {
    label: "App Secret",
    badge: preview ? t("secretConfigured") : t("secretNotSet"),
    badgeTone: preview ? "ok" : undefined,
    hint: t("secretHint"),
    children: jsx("input", {
      id: "connect-lark-appSecret", className: "cl-input", type: "password",
      value: state.secretDraft,
      placeholder: preview ? t("secretReplace") : t("secretNew"),
      disabled, autoComplete: "new-password", spellCheck: false,
      onChange: (event) => onEdit(event.target.value),
    }),
  });
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
    jsx(PermissionPicker, { value: value("permissionPreset"), onEdit: edit("permissionPreset"), disabled, open, setOpen, t }),
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
        jsx("span", { className: "cl-picker-sub", children: route ? value("provider").text : defaultName ? t("dshDefault") + " · " + defaultName : t("followDsh") }),
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
          defaultName ? jsx("span", { className: "cl-option-desc", children: t("dshDefault") + " · " + defaultName }) : null,
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

function permissionOptions(t) {
  return [
    { value: "", label: t("permissionFollow"), description: t("permissionFollowDesc") },
    { value: "read-only", label: t("permissionReadOnly"), description: t("permissionReadOnlyDesc") },
    { value: "workspace-write", label: t("permissionWorkspaceWrite"), description: t("permissionWorkspaceWriteDesc") },
    { value: "danger-full-access", label: t("permissionFullAccess"), description: t("permissionFullAccessDesc") },
    { value: "auto", label: t("permissionAuto"), description: t("permissionAutoDesc") },
  ];
}

function PermissionPicker({ value, onEdit, disabled, open, setOpen, t }) {
  const options = permissionOptions(t);
  const current = options.find((option) => option.value === value.text) || options[0];
  const isOpen = open === "permission";
  const close = () => setOpen(null);
  return jsxs("div", { className: "cl-picker", children: [
    jsx("span", { className: "cl-label", children: t("permissionLabel") }),
    jsxs("button", { type: "button", className: "cl-picker-trigger", disabled, onClick: () => setOpen(isOpen ? null : "permission"), children: [
      // 触发器只放选项名：描述在窄列里必然截断，完整说明保留在菜单项与下方 hint。
      jsx("span", { className: "cl-picker-text", children:
        jsx("span", { className: "cl-picker-title", children: current.label }),
      }),
      jsx("span", { className: "cl-chevron", children: isOpen ? "▲" : "▼" }),
    ] }),
    jsx("p", { className: "cl-hint", children: t("permissionHint") }),
    isOpen ? jsxs(React.Fragment, { children: [
      jsx("div", { className: "cl-menu-shield", onClick: () => setOpen(false) }),
      jsx("div", { className: "cl-menu", role: "listbox", children: options.map((option) => jsx("button", {
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
  // 外壳交给宿主的 Modal：层级、Esc、点外部关闭、焦点都归它管，本组件只画内容。
  return jsx(P.Modal, {
    open: true,
    onClose,
    title: t("browserTitle"),
    closeLabel: t("close"),
    children: jsxs("div", { className: "cl-browser", children: [
      jsxs("div", { className: "cl-browser-path", children: [
        jsx("input", { className: "cl-input", value: pathInput, "aria-label": t("browserPathLabel"), onChange: (event) => setPathInput(event.target.value), onKeyDown: (event) => { if (event.key === "Enter") load(pathInput); } }),
        listing?.home ? jsx(P.Button, { variant: "outline", size: "sm", onClick: () => load(listing.home), children: t("browserHome") }) : null,
      ] }),
      error ? jsx("p", { className: "cl-hint", role: "alert", children: error }) : null,
      jsx("div", { className: "cl-browser-list", children: loading ? jsx("div", { className: "cl-empty", children: t("browserLoading") }) : (listing?.entries || []).filter((entry) => showHidden || !entry.hidden).map((entry) => jsx("button", {
        type: "button", className: "cl-browser-entry", onClick: () => load(entry.path), children: jsxs("span", { children: ["▸ ", entry.name] }),
      }, entry.path)) }),
      listing?.truncated ? jsx("p", { className: "cl-hint", children: t("browserTruncated") }) : null,
      creating ? jsxs("div", { className: "cl-browser-create", children: [
        jsx("input", { className: "cl-input", value: folderName, placeholder: t("browserFolderName"), onChange: (event) => setFolderName(event.target.value) }),
        jsx(P.Button, { variant: "primary", size: "sm", onClick: create, children: t("browserCreate") }),
      ] }) : null,
    ] }),
    footer: jsxs("div", { className: "cl-browser-footer", children: [
      jsxs("div", { className: "cl-browser-tools", children: [
        jsx(P.Button, { variant: "outline", size: "sm", onClick: () => setCreating(!creating), children: t("browserNewFolder") }),
        jsx(P.Button, { variant: "ghost", size: "sm", onClick: () => setShowHidden(!showHidden), children: showHidden ? t("browserHideHidden") : t("browserShowHidden") }),
      ] }),
      jsxs("div", { className: "cl-modal-actions", children: [
        jsx(P.Button, { variant: "outline", size: "sm", onClick: onClose, children: t("cancel") }),
        jsx(P.Button, { variant: "primary", size: "sm", disabled: !listing, onClick: () => onPick(listing.path), children: t("browserOpen") }),
      ] }),
    ] }),
  });
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
  const copy = async () => {
    try { await navigator.clipboard.writeText(guideJson(t)); setCopied(true); } catch { setCopied(false); }
  };
  // 同 WorkspaceDialog：外壳用宿主 Modal，Esc/遮罩/层级由宿主接管。
  return jsx(P.Modal, {
    open: true,
    onClose,
    title: t("guideTitle"),
    closeLabel: t("guideClose"),
    children: jsxs("div", { children: [
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
      jsx("pre", { className: "cl-code", children: guideJson(t) }),
      jsx("p", { className: "cl-modal-note", children: t("guideNote") }),
    ] }),
    footer: jsxs("div", { className: "cl-modal-actions", children: [
      jsx("a", { className: "cl-primary", href: "https://open.feishu.cn/app", target: "_blank", rel: "noreferrer", children: t("guideOpen") + " ↗" }),
      jsx(P.Button, { variant: "outline", size: "sm", onClick: copy, children: copied ? t("guideCopied") + " ✓" : t("guideCopy") }),
    ] }),
  });
}

/** 统一搜索：一个人、一个群、一个 id 都能搜到，命中即授权。 */
function DirectoryPicker({ value, onEdit, t, disabled }) {
  const [state, setState] = React.useState({ status: "idle", users: [], chats: [], manager: null, reason: "" });
  const [query, setQuery] = React.useState("");

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const response = await fetch("http://127.0.0.1:9092/lark-api/directory", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
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
      ? jsx(P.Button, {
          type: "button",
          variant: "outline",
          size: "sm",
          disabled,
          onClick: () => grantUser(state.manager),
          children: t("useManager"),
        })
      : null,
  ] });

  const body = state.status === "loading"
    ? jsx("div", { className: "cl-users-note", children: t("loadingUsers") })
    : state.status === "unavailable"
      ? jsx("div", { className: "cl-users-note warn", children: t("directoryUnavailable") })
      : users.length === 0 && chats.length === 0
        ? jsx("div", { className: "cl-users-note", children: t("noUsers") })
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
        jsx("span", { className: "cl-node", children: value("domain").text === "lark" ? "Lark" : t("appName") }),
        jsx("span", { className: "cl-arrow", children: "→" }),
        jsx("span", { className: "cl-node", children: "DSH Agent" }),
      ] }),
    ] }),
    disabled && jsx("div", { className: "cl-catalog-error", role: "alert", children: t("unavailable") }),
    !disabled && state.readOnly === true ? jsx("div", { className: "cl-catalog-error", role: "alert", children: t("readOnly") }) : null,
    jsx(Section, { number: "01", title: t("connection"), hint: t("connectionHint"), action: jsx("button", { type: "button", className: "cl-guide-link", onClick: () => setGuideOpen(true), children: t("guideButton") + " ↗" }), children: [
      jsx("div", { className: "cl-segment", role: "radiogroup", "aria-label": t("domain"), children: ["feishu", "lark"].map((domain) => jsx("button", {
        type: "button", role: "radio", "aria-checked": value("domain").text === domain,
        disabled, onClick: () => edit("domain")(domain), children: t(domain),
      }, domain)) }),
      jsxs("div", { className: "cl-grid", children: [
        jsx(TextField, { id: "connect-lark-appId", label: t("appId"), hint: t("appIdHint"), value: value("appId"), placeholder: t("appIdPlaceholder"), disabled, onEdit: edit("appId"), mask: true, t }),
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
    state.saveStatus !== "idle" ? jsx("p", {
      className: "cl-savebar" + (state.saveStatus === "error" ? " err" : ""),
      role: "status",
      children: state.saveStatus === "pending" ? t("statusPending")
        : state.saveStatus === "saving" ? t("statusSaving")
        : state.saveStatus === "saved" ? t("statusSaved")
        : jsxs(React.Fragment, { children: [
            t("statusFailed") + (state.saveError ? "：" + state.saveError : ""),
            jsx("button", { className: "cl-retry", type: "button", onClick: () => props.save(), children: t("retry") }),
          ] }),
    }) : null,
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
