// dsh-remote — 远程访问（Cloudflare 临时隧道 + 密码门 + 飞书通知）。
// 市场页（Plugins → Nano Market）由 @oh-summy/nano-market 提供；本插件不再占页签，
// 而是在自己的详情页里给出远程访问的完整管理面（隧道、密码、飞书通知）。
// 实现：宿主在插件详情页渲染 plugins.bundle.config 区段（排在「来源信息」之上）。
// 界面全部用宿主原语（Switch / Tag / Button / Tooltip / Modal / Input /
// SegmentedControl）和宿主设计令牌（--dsw-*），文案走 ctx.locale 字典（zh/en），
// 暗色主题与英文界面都跟着宿主走；离开页面时清理轮询与定时器。
const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
const P = require("@deepseek-ai/dsh-client-ui-primitives");

const NS = "dshRemote";
const PACKAGE = "@oh-summy/dsh-remote";

// 本机页面（3080）直连常驻管理面 9091（隧道停了也能操作）；远端页面（经隧道进来）同源走 Caddy。
const API_BASE = location.port === "3080" ? "http://127.0.0.1:9091" : "";

function rcApi(path, options) {
  // 默认 8s 超时：条目重启时 9091 短暂下线，socket 半开会让无超时的 fetch 挂到浏览器上限
  const opts = { credentials: "include", ...options };
  if (!opts.signal) opts.signal = AbortSignal.timeout(8000);
  return fetch(API_BASE + path, opts).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "HTTP " + res.status);
    return json;
  });
}

const zh = {
  statusRunning: "隧道运行中",
  statusStopped: "隧道已停止——远程入口关闭，无链接也无需密码",
  statusReading: "隧道状态读取中…",
  stop: "停止远程访问",
  start: "启动远程访问",
  stopping: "正在停止…",
  starting: "正在启动…（新链接几秒后出现）",
  copyLink: "复制链接",
  copyPassword: "复制密码",
  copied: "已复制",
  failed: "失败：",
  done: "完成",
  urlTip: "临时隧道免 Cloudflare 账号配置；地址会不定期更换，新地址通过飞书通知自动送达。",
  password: "访问密码",
  reveal: "显示密码",
  hide: "隐藏密码",
  resetPassword: "重置密码",
  resetTitle: "重置密码？",
  resetDescription: "所有已登录会话将失效，新密码随下次开启通知推送。",
  resetConfirm: "重置",
  resetting: "正在重置…",
  resetDone: "密码已重置",
  notify: "飞书通知",
  notifyTip: "开启后选择群聊或私聊；链接变化时自动推送新地址和完整密码。",
  notifyOn: "通知已开启",
  notifyOff: "通知已关闭",
  channelGroup: "群聊",
  channelDm: "私聊",
  switchedGroup: "已切到群聊",
  switchedDm: "已切到私聊",
  sendTest: "发送测试",
  testing: "测试中…",
  sessionDays: "会话有效期",
  sessionDaysTip: "远程登录保持登录的天数，可选 1–30 天。",
  dayUnit: "天",
  autoRestart: "自动重启",
  autoRestartTip: "临时隧道进程意外退出后 5 秒内自动重拉。",
  autoStart: "跟随 DSH 启动",
  autoStartTip: "开启后每次 DSH 启动都会自动拉起隧道，并经飞书推送新链接和密码；关闭则只在手动点「启动」时开启。切换在下次启动 DSH 时生效。",
  autoStartSaved: "已保存，下次启动 DSH 时生效",
  envHintCloudflared: "未安装——brew install cloudflared（装最新版即可，quick tunnel 无需 Cloudflare 账号）",
  envHintCaddy: "未安装——brew install caddy（装最新版即可）",
  envTitle: "环境检查",
  eventsTitle: "事件",
  envReading: "读取中…",
  envUnreachable: "管理面未连接，暂无法执行环境检查。",
  noEvents: "（暂无）",
  managerUnreachable: "管理面未连接——本实例未开放管理 API，远程访问需在 3080 主实例操作。",
  managerRetrying: "管理面连接中…（{error}，数秒内自动恢复）",
  retry: "重试",
  retrying: "重试中…",
  appId: "App ID",
  appIdTip: "开放平台 → 凭证与基础信息里的 cli_ 开头 ID。",
  appSecret: "App Secret",
  appSecretTip: "同一页面；只存本机凭据缝，不进仓库不进配置文件。",
  secretConfigured: "已配置 {mask}，输入新值覆盖",
  secretNew: "输入新的 App Secret",
  checkLabel: "配置检查",
  checkTipGroup: "群聊需要 im:chat + im:message 权限，且机器人已被拉进群。",
  checkTipDm: "私聊需要 im:message 权限。",
  checkRunning: "检查中…",
  checkCredential: "凭据",
  checkImMessage: "im:message 发消息",
  checkImChat: "im:chat 拉群列表",
  checkRecheck: "重新检查",
  checkMissing: "缺权限：到开放平台开通后点重新检查",
  checkInvalid: "凭据无效：{error}",
  checkFailed: "检查失败：{error}",
  checkAppHint: "请检查 App ID / Secret",
  notifyTo: "通知到群",
  notifyToTip: "用应用身份发到选定的群；或用下面的群机器人 webhook，二选一。",
  noChatSelected: "（点右侧拉取）",
  chatSelected: "已选：{name}",
  noChatOption: "（不通知到群）",
  fetchChats: "拉取群列表",
  fetchingChats: "拉取群列表中…",
  noChats: "机器人还不在任何群里——先在飞书里把它拉进一个群再试。",
  fetchedChats: "已拉到 {count} 个群，选择后即保存",
  orBot: "或群机器人",
  orBotTip: "群里加「自定义机器人」拿到 webhook 地址即可，不用 App ID。",
  webhookConfigured: "已配置，重新粘贴即覆盖",
  webhookNew: "webhook 地址（最简单，不用 App ID）",
  webhookSaved: "webhook 地址已保存",
  receiver: "接收者",
  receiverTip: "open_id 或 union_id（on_ 开头）；开放平台「消息日志」里可查 open_id。",
  receiverSaved: "接收者已保存",
  appIdSaved: "App ID 已保存",
  secretSaved: "App Secret 已保存",
  envCloudflared: "cloudflared",
  envCaddy: "caddy",
  envCfAccount: "Cloudflare 账号",
  envNoAccount: "临时隧道免配置，无需注册",
  envTunnelLink: "隧道链路自检",
  envLoginOk: "登录页可达",
  envDshSecret: "DSH 会话密钥（远程登录免二次校验）",
  envNotRead: "未读取到",
  cancel: "取消",
};

const en = {
  statusRunning: "Tunnel running",
  statusStopped: "Tunnel stopped — the remote entrance is closed; no link and no password needed",
  statusReading: "Reading tunnel status…",
  stop: "Stop remote access",
  start: "Start remote access",
  stopping: "Stopping…",
  starting: "Starting… (the new link appears in a few seconds)",
  copyLink: "Copy link",
  copyPassword: "Copy password",
  copied: "Copied",
  failed: "Failed: ",
  done: "Done",
  urlTip: "The quick tunnel needs no Cloudflare account; the address changes from time to time, and the new one arrives via the Feishu notification.",
  password: "Access password",
  reveal: "Show password",
  hide: "Hide password",
  resetPassword: "Reset password",
  resetTitle: "Reset password?",
  resetDescription: "All signed-in sessions become invalid; the new password is pushed with the next notification.",
  resetConfirm: "Reset",
  resetting: "Resetting…",
  resetDone: "Password reset",
  notify: "Feishu notification",
  notifyTip: "Turn on to pick a group chat or a direct message; new addresses and the full password are pushed automatically.",
  notifyOn: "Notifications on",
  notifyOff: "Notifications off",
  channelGroup: "Group chat",
  channelDm: "Direct message",
  switchedGroup: "Switched to group chat",
  switchedDm: "Switched to direct message",
  sendTest: "Send test",
  testing: "Sending test…",
  sessionDays: "Session lifetime",
  sessionDaysTip: "How many days a remote sign-in stays signed in, 1–30.",
  dayUnit: "day(s)",
  autoRestart: "Auto restart",
  autoRestartTip: "Restarts the quick tunnel within 5 seconds if it exits unexpectedly.",
  autoStart: "Start with DSH",
  autoStartTip: "When on, every DSH start brings the tunnel up automatically and pushes the fresh link and password via Feishu; when off, it only starts when you press Start. Takes effect the next time DSH starts.",
  autoStartSaved: "Saved; takes effect next time DSH starts",
  envHintCloudflared: "Not installed — brew install cloudflared (latest is fine; the quick tunnel needs no Cloudflare account)",
  envHintCaddy: "Not installed — brew install caddy (latest is fine)",
  envTitle: "Environment check",
  eventsTitle: "Events",
  envReading: "Reading…",
  envUnreachable: "The manager is unreachable; the environment check is unavailable.",
  noEvents: "(none)",
  managerUnreachable: "Manager unreachable — this instance exposes no management API; manage remote access on the 3080 primary instance.",
  managerRetrying: "Manager connecting… ({error}; recovers in seconds)",
  retry: "Retry",
  retrying: "Retrying…",
  appId: "App ID",
  appIdTip: "The cli_-prefixed ID under Credentials & basic info on the open platform.",
  appSecret: "App Secret",
  appSecretTip: "Same page; stored only in the local credential vault — never in the repo or config files.",
  secretConfigured: "Configured {mask}; type a new value to replace",
  secretNew: "Type a new App Secret",
  checkLabel: "Credential check",
  checkTipGroup: "Group chat needs im:chat + im:message, and the bot must be in the group.",
  checkTipDm: "Direct message needs im:message.",
  checkRunning: "Checking…",
  checkCredential: "Credentials",
  checkImMessage: "im:message (send)",
  checkImChat: "im:chat (list groups)",
  checkRecheck: "Re-check",
  checkMissing: "Missing permission: enable it on the open platform, then re-check",
  checkInvalid: "Invalid credentials: {error}",
  checkFailed: "Check failed: {error}",
  checkAppHint: "Check the App ID / Secret",
  notifyTo: "Post to group",
  notifyToTip: "Posts to the chosen group as the app; or use the group-bot webhook below — pick one.",
  noChatSelected: "(fetch on the right)",
  chatSelected: "Selected: {name}",
  noChatOption: "(no group notification)",
  fetchChats: "Fetch groups",
  fetchingChats: "Fetching groups…",
  noChats: "The bot is in no group yet — add it to a group in Feishu and retry.",
  fetchedChats: "Fetched {count} groups; picking one saves it",
  orBot: "Or a group bot",
  orBotTip: "Add a \"Custom bot\" in the group to get a webhook URL — no App ID needed.",
  webhookConfigured: "Configured; paste a new one to replace",
  webhookNew: "Webhook URL (simplest; no App ID needed)",
  webhookSaved: "Webhook URL saved",
  receiver: "Receiver",
  receiverTip: "open_id or union_id (on_-prefixed); find the open_id under \"Message log\" on the open platform.",
  receiverSaved: "Receiver saved",
  appIdSaved: "App ID saved",
  secretSaved: "App Secret saved",
  envCloudflared: "cloudflared",
  envCaddy: "caddy",
  envCfAccount: "Cloudflare account",
  envNoAccount: "The quick tunnel needs no configuration or registration",
  envTunnelLink: "Tunnel self-check",
  envLoginOk: "sign-in page reachable",
  envDshSecret: "DSH session secret (remote sign-in skips the second check)",
  envNotRead: "not found",
  cancel: "Cancel",
};

// 管理面连不上时给一句人话，而不是把「HTTP 404」这种原始错误甩给用户。
// 404/网络层失败 = 本实例没提供管理 API（如测试实例的 9091 端口被主实例占着），
// 这种是常驻状态，不该谎称「数秒内自动恢复」。
function managerUnreachableText(message, t) {
  if (/404|failed to fetch|networkerror|econnrefused/i.test(String(message || ""))) return t("managerUnreachable");
  return t("managerRetrying", { error: String(message || "") });
}

// 版式令牌：颜色只允许 --dsw-*（fallback 除外），弹窗/开关/按钮本体来自宿主原语。
const RC_CSS = `
.rc-wrap{display:flex;flex-direction:column;gap:12px;max-width:760px;position:relative}
@keyframes rcToastIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.rc-toast{position:absolute;top:-18px;right:0;z-index:20;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:6px 12px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.18);animation:rcToastIn .18s ease;max-width:60%}
.rc-toast.err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 88%,#000)}
.rc-row{display:flex;align-items:center;gap:10px;min-height:32px;flex-wrap:wrap}
.rc-label{display:inline-flex;align-items:center;gap:6px;min-width:110px;color:var(--dsw-alias-label-secondary);font-size:13px}
.rc-control{flex:1;min-width:220px;display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
.rc-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-sm);padding:3px 10px;word-break:break-all}
.rc-code-copy{cursor:pointer;transition:color .12s}
.rc-code-copy:hover{color:var(--dsw-alias-state-business-primary)}
.rc-code-copy:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.rc-link{color:var(--dsw-alias-state-business-primary);word-break:break-all;text-decoration:none}
.rc-link:hover{text-decoration:underline}
.rc-msg{color:var(--dsw-alias-label-secondary);font-size:13px;min-height:18px;margin:0}
.rc-msg.err{color:var(--dsw-alias-state-error-primary)}
.rc-danger{color:var(--dsw-alias-state-error-primary)}
.rc-sec{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 0}
.rc-events{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px 12px;max-height:200px;overflow:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3);display:flex;flex-direction:column;gap:2px}
.rc-input{max-width:360px}
.rc-days{height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
`;

// 行内 ⓘ：紧跟标签文字，悬停出宿主 Tooltip——页面本体不放说明长文。
function InfoTip({ label }) {
  return jsx(P.Tooltip, { label, side: "top", portal: true, delayMs: 200, children:
    jsx("span", { role: "note", "aria-label": label, style: { display: "inline-flex", color: "var(--dsw-alias-label-tertiary)", cursor: "help" }, children:
      jsx(P.IconQuestionOutlineRegular, { size: 14 }) }) });
}

function Row({ label, tip, children }) {
  return jsxs("div", { className: "rc-row", children: [
    jsx("span", { className: "rc-label", children: label }),
    tip ? jsx(InfoTip, { label: tip }) : null,
    jsx("span", { className: "rc-control", children }),
  ] });
}

function envRow(key, name, ok, detail) {
  return jsxs("div", { className: "rc-row", key, children: [
    jsx(P.Tag, { tone: ok ? "success" : "danger", children: ok ? "✓" : "✗" }),
    jsxs("span", { children: [name, detail ? " — " + detail : ""] }),
  ] });
}

/** 远程访问管理面：轮询本机管理面 API，全部操作走宿主原语。 */
function RemoteManager({ t: hostT, locale }) {
  // 语言自定：宿主 locale 面可订阅（真机）时直查本地字典，切换立即生效；
  // 无 subscribe 的环境（测试沙箱）沿用注入的 t，保持渲染契约。
  const reactive = typeof locale?.subscribe === "function";
  const [lang, setLang] = React.useState(() => (locale?.getSnapshot?.()?.active === "en" ? "en" : "zh"));
  React.useEffect(() => {
    if (!reactive) return undefined;
    return locale.subscribe(() => setLang(locale.getSnapshot().active === "en" ? "en" : "zh"));
  }, [locale, reactive]);
  const t = React.useCallback((key, vars) => {
    if (!reactive) return hostT(key, vars);
    const table = lang === "en" ? en : zh;
    let text = table[key] !== undefined ? table[key] : (en[key] ?? zh[key] ?? key);
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.split("{" + k + "}").join(String(v));
    return text;
  }, [lang, hostT, reactive]);
  const [state, setState] = React.useState(null);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState(null); // {text, err}
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [env, setEnv] = React.useState(null);
  const [appCheck, setAppCheck] = React.useState(null);
  const [chats, setChats] = React.useState(null);
  const [appIdDraft, setAppIdDraft] = React.useState(undefined);
  const [secretDraft, setSecretDraft] = React.useState(undefined);
  const [hookDraft, setHookDraft] = React.useState(undefined);
  const [oidDraft, setOidDraft] = React.useState(undefined);
  const liveRef = React.useRef(true);
  const lastChannelRef = React.useRef("group");

  React.useEffect(() => () => { liveRef.current = false; }, []);

  // manual = 用户点了「重试」：给按钮挂进行中反馈；5s 轮询走无参调用，不闪按钮。
  const refresh = React.useCallback(async (manual) => {
    if (manual) setRefreshing(true);
    try {
      const next = await rcApi("/rc-api/state");
      if (!liveRef.current) return;
      setState(next);
      setError("");
    } catch (reason) {
      if (!liveRef.current) return;
      setError(reason?.message || String(reason));
    } finally {
      if (manual && liveRef.current) setRefreshing(false);
    }
  }, []);

  // 状态轮询：5s 一拍，与旧版一致。
  React.useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  // 消息是反馈不是状态：几秒后自动消失（失败类停留久一点）。
  React.useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(null), message.err ? 8000 : 3500);
    return () => clearTimeout(timer);
  }, [message]);

  // 明文密码 30 秒后自动收起。
  React.useEffect(() => {
    if (!revealed) return undefined;
    const timer = setTimeout(() => setRevealed(false), 30000);
    return () => clearTimeout(timer);
  }, [revealed]);

  // 环境检查只跑一次；失败不重试（有专门的手动重试入口在状态行）。
  React.useEffect(() => {
    let live = true;
    rcApi("/rc-api/envcheck").then((e) => { if (live) setEnv(e); }).catch(() => { if (live) setEnv({ unreachable: true }); });
    return () => { live = false; };
  }, []);

  async function act(path, pending, body, doneText) {
    setMessage({ text: pending });
    setBusy(true);
    try {
      const r = await rcApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      setMessage(r && r.error ? { text: t("failed") + r.error, err: true } : { text: doneText ?? (r && r.detail ? String(r.detail) : t("done")) });
    } catch (reason) {
      setMessage({ text: t("failed") + (reason?.message || String(reason)), err: true });
    }
    setBusy(false);
    setTimeout(() => { if (liveRef.current) void refresh(); }, 400);
  }

  const ch = (state?.channel || "off");
  const chOn = ch !== "off";
  if (chOn) lastChannelRef.current = ch === "dm" ? "dm" : "group";
  const channel = chOn ? ch : lastChannelRef.current;

  const runAppCheck = React.useCallback(async () => {
    setAppCheck({ checking: true });
    try {
      const r = await rcApi("/rc-api/appcheck");
      if (liveRef.current) setAppCheck({ result: r });
    } catch (reason) {
      if (liveRef.current) setAppCheck({ error: reason?.message || String(reason) });
    }
  }, []);

  // 凭据齐了就自动体检（与旧版一致）。
  const hasCredentials = Boolean(state?.appIdMask && state?.hasAppSecret);
  React.useEffect(() => {
    if (hasCredentials) void runAppCheck();
  }, [hasCredentials, runAppCheck]);

  async function revealPassword() {
    if (revealed) { setRevealed(false); return; }
    try {
      const r = await rcApi("/rc-api/reveal", { method: "POST" });
      setPassword(r.password);
      setRevealed(true);
    } catch (reason) {
      setMessage({ text: t("failed") + (reason?.message || ""), err: true });
    }
  }

  async function copyPassword() {
    try {
      const r = await rcApi("/rc-api/reveal", { method: "POST" });
      await navigator.clipboard.writeText(r.password);
      setCopied(true); // 按钮自身的瞬时反馈；不再占用下面的消息行
    } catch (reason) {
      setMessage({ text: t("failed") + (reason?.message || ""), err: true });
    }
  }

  // 已复制的瞬时反馈：1.6s 后自动弹回，不引入独立提示行
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  async function fetchChats() {
    setMessage({ text: t("fetchingChats") });
    try {
      const r = await rcApi("/rc-api/chats");
      if (!r.chats || r.chats.length === 0) { setMessage({ text: t("noChats"), err: true }); return; }
      setChats(r.chats);
      setMessage({ text: t("fetchedChats", { count: r.chats.length }) });
    } catch (reason) {
      setMessage({ text: t("failed") + (reason?.message || ""), err: true });
    }
  }

  // 掩码输入的通用语义：聚焦清掉掩码（露出 placeholder），失焦提交新值；
  // 没有新值就恢复掩码展示。等价于旧版的 onchange 提交，不会逐键请求。
  function maskedInput({ mask, draft, setDraft, placeholder, commit }) {
    const shown = draft !== undefined ? draft : (mask || "");
    return jsx(P.Input, {
      className: "rc-input",
      value: shown,
      placeholder,
      disabled: busy,
      onFocus: () => { if (shown === mask) setDraft(""); },
      onChange: (event) => setDraft(event.target.value),
      onBlur: () => {
        const value = shown.trim();
        if (value && value !== mask) commit(value);
        setDraft(undefined);
      },
    });
  }

  const errorRow = error ? jsxs("div", { className: "rc-row", children: [
    jsx("p", { className: "rc-msg err", role: "alert", children: managerUnreachableText(error, t) }),
    // 重试要有进行中反馈：禁用 + 换字，避免「点了像没点」。
    jsx(P.Button, { variant: "outline", size: "sm", disabled: refreshing, onClick: () => void refresh(true), children: refreshing ? t("retrying") : t("retry") }),
  ] }) : null;

  const statusRow = jsxs("div", { className: "rc-row", children: [
    state === null && !error ? jsx(P.Tag, { tone: "neutral", children: t("statusReading") })
      : state ? jsx(P.Tag, { tone: state.running ? "success" : "neutral", children: state.running ? t("statusRunning") : t("statusStopped") })
      : null,
    state?.running
      ? jsx(P.Button, { variant: "outline", size: "sm", className: "rc-danger", disabled: busy, onClick: () => act("/rc-api/toggle", t("stopping")), children: t("stop") })
      : state
        ? jsx(P.Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => act("/rc-api/toggle", t("starting")), children: t("start") })
        : null,
  ] });

  const urlRow = state?.running && state.url ? jsxs("div", { className: "rc-row", children: [
    jsx("a", { className: "rc-link", target: "_blank", href: state.url, children: state.url }),
    jsx(InfoTip, { label: t("urlTip") }),
    jsx(P.Button, { variant: "ghost", size: "sm", onClick: () => {
      navigator.clipboard.writeText(state.url).then(() => setMessage({ text: t("copied") })).catch((reason) => setMessage({ text: t("failed") + (reason?.message || ""), err: true }));
    }, children: t("copyLink") }),
  ] }) : null;

  const passwordRow = state?.running ? jsxs("div", { className: "rc-row", children: [
    jsx("span", { className: "rc-label", children: t("password") }),
    // 点密码即复制（不展示明文）；键盘可达：Enter/Space 触发
    jsx("span", { className: "rc-code rc-code-copy", role: "button", tabIndex: 0, title: t("copyPassword"),
      onClick: () => void copyPassword(),
      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void copyPassword(); } },
      children: revealed ? password : (state.passwordMask || "••••") }),
    jsx(P.Button, { variant: "ghost", size: "sm", onClick: () => void copyPassword(), children: copied ? t("copied") + " ✓" : t("copyPassword") }),
    jsx(P.Button, { variant: "ghost", size: "sm", onClick: () => void revealPassword(), children: revealed ? t("hide") : t("reveal") }),
    jsx(P.Button, { variant: "outline", size: "sm", className: "rc-danger", disabled: busy, onClick: () => setConfirmReset(true), children: t("resetPassword") }),
  ] }) : null;

  const checkBody = jsxs(Fragment, { children: [
    appCheck === null ? null
      : appCheck.checking ? jsx("span", { className: "rc-msg", children: t("checkRunning") })
      : appCheck.error ? jsx("span", { className: "rc-msg err", children: t("checkFailed", { error: appCheck.error }) })
      : appCheck.result.token ? jsxs(Fragment, { children: [
          jsx(P.Tag, { tone: "success", children: t("checkCredential") }),
          appCheck.result.imMessage === false ? jsx(P.Tag, { tone: "danger", children: t("checkImMessage") }) : null,
          channel === "group" && appCheck.result.imChat === false ? jsx(P.Tag, { tone: "danger", children: t("checkImChat") }) : null,
          appCheck.result.imMessage === false || (channel === "group" && appCheck.result.imChat === false)
            ? jsx("span", { className: "rc-msg err", children: t("checkMissing") }) : null,
        ] })
      : jsx("span", { className: "rc-msg err", children: t("checkInvalid", { error: appCheck.result.error || t("checkAppHint") }) }),
  ] });

  const channelForm = chOn ? jsxs(Fragment, { children: [
    Row({ label: t("appId"), tip: t("appIdTip"), children:
      maskedInput({ mask: state?.appIdMask || "", draft: appIdDraft, setDraft: setAppIdDraft, placeholder: "cli_xxxx", commit: (v) => act("/rc-api/config", t("appIdSaved"), { notifyAppId: v }) }) }),
    Row({ label: t("appSecret"), tip: t("appSecretTip"), children:
      jsx(P.Input, {
        className: "rc-input", type: "password", disabled: busy,
        placeholder: state?.appSecretMask ? t("secretConfigured", { mask: state.appSecretMask }) : t("secretNew"),
        value: secretDraft ?? "",
        onChange: (event) => setSecretDraft(event.target.value),
        onBlur: () => {
          const value = (secretDraft ?? "").trim();
          if (value) act("/rc-api/notify-secret", t("secretSaved"), { appSecret: value });
          setSecretDraft(undefined);
        },
      }) }),
    Row({ label: t("checkLabel"), tip: channel === "group" ? t("checkTipGroup") : t("checkTipDm"), children: jsxs(Fragment, { children: [
      checkBody,
      jsx(P.Button, { variant: "outline", size: "sm", disabled: busy || !hasCredentials, onClick: () => void runAppCheck(), children: t("checkRecheck") }),
    ] }) }),
    channel === "group" ? jsxs(Fragment, { children: [
      Row({ label: t("notifyTo"), tip: t("notifyToTip"), children: jsxs(Fragment, { children: [
        jsx("select", {
          className: "rc-days", disabled: busy,
          "aria-label": t("notifyTo"),
          value: state?.chatId || "",
          onChange: (event) => {
            const option = event.target.selectedOptions[0];
            act("/rc-api/config", option?.textContent || t("done"), { notifyChatId: event.target.value, notifyChatName: option?.textContent || "" });
          },
          children: chats
            ? [jsx("option", { value: "", children: t("noChatOption") }, "none"),
               ...chats.map((c) => jsx("option", { value: c.chatId, children: c.name }, c.chatId))]
            : [jsx("option", { value: "", children: state?.chatId ? t("chatSelected", { name: state.chatName || state.chatId }) : t("noChatSelected") }, "current")],
        }),
        jsx(P.Button, { variant: "outline", size: "sm", disabled: busy, onClick: () => void fetchChats(), children: t("fetchChats") }),
      ] }) }),
      Row({ label: t("orBot"), tip: t("orBotTip"), children:
        jsx(P.Input, {
          className: "rc-input", disabled: busy,
          placeholder: state?.hasWebhook ? t("webhookConfigured") : t("webhookNew"),
          value: hookDraft ?? "",
          onChange: (event) => setHookDraft(event.target.value),
          onBlur: () => {
            const value = (hookDraft ?? "").trim();
            if (hookDraft !== undefined) act("/rc-api/notify-secret", t("webhookSaved"), { webhookUrl: value || undefined });
            setHookDraft(undefined);
          },
        }) }),
    ] }) : (
      Row({ label: t("receiver"), tip: t("receiverTip"), children:
        maskedInput({ mask: state?.openIdMask || "", draft: oidDraft, setDraft: setOidDraft, placeholder: "ou_xxxx / on_xxxx", commit: (v) => act("/rc-api/config", t("receiverSaved"), { notifyOpenId: v }) }) })
    ),
  ] }) : null;

  // 跟随启动：独立于「现在是否在跑」的模式开关（写 settings.json，下次启动 DSH 生效）
  const autoStartRow = Row({ label: t("autoStart"), tip: t("autoStartTip"), children:
    jsx(P.Switch, {
      checked: state?.autoStart === true,
      label: t("autoStart"),
      disabled: busy || state === null,
      onChange: () => act("/rc-api/config", t("autoStartSaved"), { autoStart: !(state?.autoStart === true) }),
    }) });

  const envRows = env === null ? jsx("span", { className: "rc-msg", children: t("envReading") })
    : env.unreachable ? jsx("span", { className: "rc-msg", children: t("envUnreachable") })
    : jsxs(Fragment, { children: [
        envRow("cloudflared", t("envCloudflared"), env.cloudflared.found,
          env.cloudflared.found ? (env.cloudflared.version || env.cloudflared.path || "") : t("envHintCloudflared")),
        envRow("caddy", t("envCaddy"), env.caddy.found,
          env.caddy.found ? (env.caddy.version || env.caddy.path || "") : t("envHintCaddy")),
        envRow("cf", t("envCfAccount"), env.cfAccount, t("envNoAccount")),
        env.tunnelLink ? envRow("tunnel", t("envTunnelLink"), env.tunnelLink.ok, env.tunnelLink.ok ? "HTTP " + env.tunnelLink.status + " · " + t("envLoginOk") : String(env.tunnelLink.status)) : null,
        envRow("secret", t("envDshSecret"), env.dshSecret, env.dshSecret ? "" : t("envNotRead")),
      ] });

  return jsxs("div", { className: "rc-wrap", children: [
    jsx("style", { children: RC_CSS }),
    errorRow,
    statusRow,
    autoStartRow,
    urlRow,
    passwordRow,
    // 瞬时反馈走浮窗：不独占一行、不推移布局
    message ? jsx("p", { className: "rc-toast" + (message.err ? " err" : ""), role: "status", children: message.text }) : null,
    Row({ label: t("notify"), tip: t("notifyTip"), children: jsxs(Fragment, { children: [
      jsx(P.Switch, {
        checked: chOn,
        label: t("notify"),
        disabled: busy || state === null,
        onChange: () => {
          const next = chOn ? "off" : lastChannelRef.current;
          act("/rc-api/config", next === "off" ? t("notifyOff") : t("notifyOn"), { notifyChannel: next });
        },
      }),
      chOn ? jsx(P.SegmentedControl, {
        id: "rc-channel",
        label: t("notify"),
        value: channel,
        options: [
          { value: "group", label: t("channelGroup") },
          { value: "dm", label: t("channelDm") },
        ],
        onChange: (next) => act("/rc-api/config", next === "group" ? t("switchedGroup") : t("switchedDm"), { notifyChannel: next }),
      }) : null,
      chOn ? jsx(P.Button, { variant: "outline", size: "sm", disabled: busy, onClick: () => act("/rc-api/test", t("testing")), children: t("sendTest") }) : null,
    ] }) }),
    channelForm,
    Row({ label: t("sessionDays"), tip: t("sessionDaysTip"), children:
      jsx("select", {
        className: "rc-days", disabled: busy || !state,
        "aria-label": t("sessionDays"),
        value: state?.sessionDays ? String(state.sessionDays) : "7",
        onChange: (event) => act("/rc-api/config", t("done"), { sessionDays: parseInt(event.target.value, 10) || 7 }),
        children: [1, 3, 7, 14, 30].map((days) => jsx("option", { value: String(days), children: days + " " + t("dayUnit") }, days)),
      }) }),
    Row({ label: t("autoRestart"), tip: t("autoRestartTip"), children:
      jsx(P.Switch, {
        checked: Boolean(state?.autoRestart),
        label: t("autoRestart"),
        disabled: busy || state === null,
        onChange: () => act("/rc-api/config", t("done"), { autoRestart: !state.autoRestart }),
      }) }),
    jsx("div", { className: "rc-sec", children: t("envTitle") }),
    envRows,
    jsx("div", { className: "rc-sec", children: t("eventsTitle") }),
    jsx("div", { className: "rc-events", children:
      (state?.events || []).length === 0 ? t("noEvents") : state.events.map((e, i) =>
        jsx("div", { className: "rc-row", children: jsxs("span", { children: [e.time, " · ", e.type, " · ", e.detail] }) }, i)),
    }),
    jsx(P.Modal, {
      open: confirmReset,
      onClose: () => setConfirmReset(false),
      title: t("resetTitle"),
      closeLabel: t("cancel"),
      description: t("resetDescription"),
      footer: jsxs(Fragment, { children: [
        jsx(P.Button, { variant: "outline", size: "sm", onClick: () => setConfirmReset(false), children: t("cancel") }),
        jsx(P.Button, { variant: "primary", size: "sm", className: "rc-danger", disabled: busy, onClick: () => { setConfirmReset(false); act("/rc-api/reset", t("resetting"), undefined, t("resetDone")); }, children: t("resetConfirm") }),
      ] }),
    }),
  ] });
}

// ---------- 槽位注册 ----------

const inject = ["slots", "locale"];

function apply(ctx) {
  if (!ctx.slots) return;
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-remote: dictionaries");
  // 配置走 plugins.bundle.config：宿主把它排在「来源信息」之上；
  // 旧用的 plugins.detail.section 会被排在「来源信息」之下——正是用户要纠正的顺序。
  // 按包名 key 注册，只在 dsh-remote 的详情页渲染本页。
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: PACKAGE,
    // 声明字典命名空间，宿主会把绑定好的翻译函数注进 props（随语言切换刷新）。
    locale: NS,
    inject: () => ({}),
  }, function DshRemoteConfigCard(props) {
    // 宿主对 keyed 配置槽以 view:"page" 渲染（整块管理页）；
    // view:"summary"（行内一句话）不画管理面，交给宿主条目描述兜底。
    const view = props.view;
    if (view === "summary") return null;
    // 语言自定：面板内部订阅宿主 locale 直查本地字典（注入 t 不保证随切换重绑）。
    return jsx(RemoteManager, { t: props.t, locale: ctx.locale });
  }));
}
