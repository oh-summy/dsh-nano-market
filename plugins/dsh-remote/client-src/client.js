// dsh-remote — 远程访问（Cloudflare 临时隧道 + 密码门 + 飞书通知）。
// 市场页（Plugins → Nano Market）由 @oh-summy/nano-market 提供；本插件不再占页签，
// 而是在自己的详情页里给出远程访问的完整管理面（隧道、密码、飞书通知）。
// 实现：宿主在插件详情页渲染 plugins.bundle.config 区段（排在「来源信息」之上），本插件用 React 挂载点
// + vanilla DOM 应用绘制管理面；离开页面时清理轮询与定时器。
const { createElement: h } = React;

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

function nmEsc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NM_CSS = `
.nm { font-family: system-ui,-apple-system,sans-serif; color: #1f2328; width: 100%; font-size: 14px; }
.nm-sec { font-size: 11px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: .05em; margin: 22px 0 6px; }
.nm-card { background: #fff; border: 1px solid #eef0f3; border-radius: 14px; padding: 8px 22px; margin-bottom: 14px; }
.nm-bare { background: #fff; border: 1px solid #eef0f3; border-radius: 14px; padding: 18px 22px; margin-bottom: 14px; }
.nm-row { display: flex; align-items: center; gap: 10px; padding: 14px 0; cursor: pointer; }
.nm-row-plain { cursor: default; }
.nm-lrow .nm-desc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nm-name { font-weight: 500; font-size: 13.5px; }
.nm-ver { color: #9ca3af; font-size: 12px; margin-left: 6px; font-family: ui-monospace,monospace; }
.nm-desc { color: #8b949e; font-size: 12px; line-height: 1.5; }
.nm-badge { background: #eef2ff; color: #4f46e5; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
.nm-badge-g { background: #f3f4f6; color: #9ca3af; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
.nm-label { min-width: 96px; color: #6b7280; font-size: 13px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; }
.nm-dot-on { color: #16a34a; font-weight: 600; font-size: 13px; }
.nm-dot-off { color: #9ca3af; font-weight: 600; font-size: 13px; }
.nm-link { color: #2563eb; word-break: break-all; text-decoration: none; }
.nm-code { background: #f6f7f9; border-radius: 6px; padding: 3px 10px; font-family: ui-monospace,monospace; font-size: 13px; }
.nm-btn { background: transparent; border: 1px solid #e5e7eb; border-radius: 8px; padding: 5px 13px; font-size: 13px; cursor: pointer; color: #4b5563; }
.nm-btn:hover { border-color: #d1d5db; background: #fafbfc; }
.nm-btn-p { background: #2563eb; border: 1px solid #2563eb; border-radius: 8px; padding: 5px 13px; font-size: 13px; cursor: pointer; color: #fff; }
.nm-btn-d { background: transparent; border: 1px solid #f3d4d4; border-radius: 8px; padding: 5px 13px; font-size: 13px; cursor: pointer; color: #dc2626; }
.nm-btn-d:hover { background: #fdf5f5; }
.nm-input { flex: 1; min-width: 220px; border: 1px solid #e8eaed; border-radius: 8px; padding: 6px 10px; font-size: 13px; box-sizing: border-box; background: #fafbfc; color: #4b5563; }
.nm-input:focus { background: #fff; outline: none; border-color: #bfdbfe; }
.nm-note { color: #9ca3af; font-size: 12px; line-height: 1.7; margin: 8px 0 0; }
.nm-msg { color: #2563eb; font-size: 13px; margin: 4px 0 0; min-height: 18px; }
.nm-events { border: 1px solid #eef0f3; border-radius: 10px; padding: 10px 12px; max-height: 200px; overflow: auto; font-size: 12px; color: #9ca3af; background: #fafbfc; }
.nm-event { padding: 3px 0; word-break: break-all; }
.nm-empty { color: #9ca3af; font-size: 13px; padding: 18px 0; text-align: center; }
.nm-sw { width: 30px; height: 17px; border-radius: 999px; background: #1f2328; position: relative; cursor: pointer; flex-shrink: 0; border: none; }
.nm-sw.off { background: #d8dbe0; }
.nm-sw i { position: absolute; top: 2px; left: 15px; width: 13px; height: 13px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.15); transition: left .15s; }
.nm-sw.off i { left: 2px; }
.nm-remote .nm-row-plain { cursor: default; }
.nm-seg { background: transparent; border: 1px solid #e5e7eb; border-radius: 8px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: #6b7280; }
.nm-seg.on { background: #1f2328; border-color: #1f2328; color: #fff; font-weight: 500; }
.nm-eye { background: none; border: none; padding: 3px; cursor: pointer; display: inline-flex; align-items: center; color: #9ca3af; border-radius: 6px; }
.nm-eye:hover { color: #1f2328; background: #f3f4f6; }
.nm-eye svg { width: 17px; height: 17px; display: block; }
.nm-info { position: relative; cursor: help; color: #c3c8cf; width: 17px; height: 17px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.nm-info:hover { color: #2563eb; }
.nm-info svg { width: 15px; height: 15px; display: block; }
.nm-info .nm-tip { display: none; position: absolute; top: 135%; left: -6px; width: 240px; background: #1f2328; color: #fff; font-size: 12px; font-weight: 400; line-height: 1.7; padding: 8px 11px; border-radius: 8px; z-index: 30; box-shadow: 0 4px 14px rgba(0,0,0,.18); text-align: left; }
.nm-info:hover .nm-tip { display: block; }
.nm-chk { font-size: 12.5px; margin-right: 12px; }
.nm-chk.ok { color: #16a34a; }
.nm-chk.bad { color: #dc2626; }
.nm-skel { height: 13px; border-radius: 6px; margin: 16px 0; background: linear-gradient(90deg,#f1f3f5 25%,#e9ecef 50%,#f1f3f5 75%); background-size: 200% 100%; animation: nmsk 1.1s infinite linear; }
.nm-skel.w60 { width: 60%; }
@keyframes nmsk { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
`;

// 密码显隐 = 小眼睛图标（无文字按钮）
const EYE_ON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
// 复制反馈：✓ 在按钮本体上闪现（不占独立提示行）
function flashOk(btn, ms = 1500) {
  if (!btn) return;
  const old = btn.innerHTML;
  btn.innerHTML = `<span style="color:#16a34a;display:inline-flex">${CHECK_SVG}</span>`;
  btn.title = "已复制";
  setTimeout(() => { btn.innerHTML = old; btn.title = btn.dataset.title || btn.title; }, ms);
}
const INFO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
// 行内 ⓘ：紧跟标签文字，悬停浮窗说明——页面本体不放说明长文
function infoTip(text) {
  return `<span class="nm-info">${INFO_SVG}<span class="nm-tip">${text}</span></span>`;
}

// ---------- vanilla 渲染辅助 ----------

function nmShell(root) {
  root.innerHTML = `<style>${NM_CSS}</style><div class="nm"></div>`;
  return root.querySelector(".nm");
}

// 管理面连不上时给一句人话，而不是把「HTTP 404」这种原始错误甩给用户。
// 404/网络层失败 = 本实例没提供管理 API（如测试实例的 9091 端口被主实例占着），
// 这种是常驻状态，不该谎称「数秒内自动恢复」。
function managerUnreachableMsg(message) {
  const s = String(message || "");
  if (/404|failed to fetch|networkerror|econnrefused/i.test(s)) {
    return "管理面未连接——本实例未开放管理 API，远程访问需在 3080 主实例操作。";
  }
  return "管理面连接中…（" + nmEsc(s) + "，数秒内自动恢复）";
}


// ---------- 远程访问详情（本插件专属管理页） ----------

function renderRemoteDetail(container, initialMsg) {
  container.innerHTML = `
    <div class="nm-remote">
      <div class="nm-card">
        <div class="nm-row nm-row-plain" id="rc-runrow"><span class="nm-dot-off">○ 隧道状态读取中…</span></div>
        <div id="rc-urlrow"></div>
        <div id="rc-pwrow"></div>
        <div class="nm-msg" id="rc-msg">${nmEsc(initialMsg || "")}</div>
        <div class="nm-row nm-row-plain"><span class="nm-label">飞书通知${infoTip("开启后选择群聊或私聊；链接变化时自动推送新地址和完整密码")}</span>
          <button class="nm-sw off" id="rc-ntfy"><i></i></button>
          <span id="rc-chrow" style="display:inline-flex;gap:6px;align-items:center"></span>
          <span style="flex:1"></span>
          <span id="rc-testslot"></span>
        </div>
        <div id="rc-chform"></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">会话有效期${infoTip("远程登录保持登录的天数，可选 1–30 天")}</span>
          <select class="nm-input" id="rc-days" style="flex:0 0 120px">
            <option value="1">1 天</option><option value="3">3 天</option><option value="7">7 天</option>
            <option value="14">14 天</option><option value="30">30 天</option>
          </select></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">自动重启${infoTip("临时隧道进程意外退出后 5 秒内自动重拉")}</span>
          <button class="nm-sw" id="rc-arestart"><i></i></button></div>
        <div class="nm-sec">环境检查</div>
        <div class="nm-events" id="rc-env">读取中…</div>
        <div class="nm-sec">事件</div>
        <div class="nm-events" id="rc-events">（暂无）</div>
      </div>
    </div>`;
  const q = (s2) => container.querySelector(s2);
  let st = null;
  let shown = false;
  let cleanupRemotePoll = null;

  async function refresh() {
    try { st = await rcApi("/rc-api/state"); }
    catch (e) {
      // 条目重启窗口（改代码/装插件才会发生，设置不再触发）：轮询会自动恢复，这里给手动重试
      q("#rc-runrow").innerHTML = `<span class="nm-dot-off">○ ${managerUnreachableMsg(e.message)}</span><button class="nm-btn" id="rc-retry">重试</button>`;
      const rb = q("#rc-retry");
      if (rb) rb.onclick = () => refresh();
      return;
    }
    q("#rc-runrow").innerHTML = st.running
      ? `<span class="nm-dot-on">● 隧道运行中</span><button class="nm-btn-d" id="rc-stop">停止远程访问</button>`
      : `<span class="nm-dot-off">○ 隧道已停止——远程入口关闭，无链接也无需密码</span><button class="nm-btn-p" id="rc-start">启动远程访问</button>`;
    const stopBtn = q("#rc-stop");
    const startBtn = q("#rc-start");
    if (stopBtn) stopBtn.onclick = () => act("/rc-api/toggle", "正在停止…");
    if (startBtn) startBtn.onclick = () => act("/rc-api/toggle", "正在启动…（新链接几秒后出现）");
    q("#rc-urlrow").innerHTML = st.running && st.url
      ? `<div class="nm-row nm-row-plain"><a class="nm-link" target="_blank" href="${nmEsc(st.url)}">${nmEsc(st.url)}</a>${infoTip("临时隧道免 Cloudflare 账号配置；地址会不定期更换，新地址通过飞书通知自动送达")}<button class="nm-eye" id="rc-copy" title="复制链接" aria-label="复制链接" data-title="复制链接">${COPY_SVG}</button></div>`
      : "";
    const copyBtn = q("#rc-copy");
    if (copyBtn) copyBtn.onclick = () => { navigator.clipboard.writeText(st.url).then(() => flashOk(copyBtn)).catch(() => setMsg("复制失败：" )); };
    // 密码行只在运行时存在：停止 = 没有链接，密码无从谈起（用户要求）
    const pwrow = q("#rc-pwrow");
    if (st.running) {
      if (!pwrow.innerHTML) {
        pwrow.innerHTML = `<div class="nm-row nm-row-plain"><span class="nm-label">访问密码</span><span class="nm-code" id="rc-pw">••••</span>
          <button class="nm-eye" id="rc-reveal" title="显示密码" aria-label="显示密码">${shown ? EYE_OFF : EYE_ON}</button>
          <button class="nm-eye" id="rc-copypw" title="复制密码" aria-label="复制密码">${COPY_SVG}</button>
          <button class="nm-btn-d" id="rc-reset">重置密码</button></div>`;
        wirePwRow();
      }
      q("#rc-pw").textContent = shown ? st.password : st.passwordMask;
      setEye(shown);
    } else if (pwrow.innerHTML) {
      pwrow.innerHTML = "";
      shown = false;
    }
    const ar = q("#rc-arestart");
    ar.className = "nm-sw" + (st.autoRestart ? "" : " off");
    ar.onclick = () => act("/rc-api/config", st.autoRestart ? "正在关闭自动重启…" : "正在开启自动重启…", { autoRestart: !st.autoRestart });
    const ntfy = q("#rc-ntfy");
    const chOn = (st.channel || "off") !== "off";
    ntfy.className = "nm-sw" + (chOn ? "" : " off");
    if (chOn) lastChannel = st.channel === "dm" ? "dm" : "group";
    if (st.sessionDays) q("#rc-days").value = String(st.sessionDays);
    const chNow = st.channel || "off";
    if (chNow !== lastChRendered || !q("#rc-chrow .nm-seg")) { lastChRendered = chNow; renderChannel(); } // 值没变不重建：避免轮询打断点击
    q("#rc-events").innerHTML = st.events.length === 0 ? "（暂无）" : st.events.map((e) => `<div class="nm-event">${nmEsc(e.time)} · ${nmEsc(e.type)} · ${nmEsc(e.detail)}</div>`).join("");
  }

  // ---------- 通知设置（总开关 + 群聊/私聊，改动即保存） ----------
  let lastChRendered = null;
  let lastChannel = "group"; // 重新打开通知时回到上次的收件方式
  function renderChannel() {
    const row = q("#rc-chrow");
    const ch = st.channel || "off";
    if (ch === "off") { row.innerHTML = ""; q("#rc-testslot").innerHTML = ""; q("#rc-chform").innerHTML = ""; return; }
    row.innerHTML = [["group", "群聊"], ["dm", "私聊"]].map(([v, t2]) =>
      `<button class="nm-seg${ch === v ? " on" : ""}" data-ch="${v}">${t2}</button>`).join("");
    for (const b of row.querySelectorAll("[data-ch]")) {
      b.onclick = () => { if (b.dataset.ch !== ch) act("/rc-api/config", b.dataset.ch === "group" ? "已切到群聊" : "已切到私聊", { notifyChannel: b.dataset.ch }); };
    }
    q("#rc-testslot").innerHTML = `<button class="nm-btn" id="rc-test">发送测试</button>`;
    const tb = q("#rc-test");
    if (tb) tb.onclick = () => act("/rc-api/test", "测试中…");
    renderChannelForm();
  }

  // 掩码输入：显示「前6位••••••」示意已配置；改动才保存，掩码原样不动时不提交
  function bindMasked(input, mask, onDirty) {
    input.dataset.mask = mask || "";
    input.onfocus = () => { if (input.value && input.value === input.dataset.mask) input.value = ""; };
    input.onblur = () => { if (!input.value.trim() && input.dataset.mask) input.value = input.dataset.mask; };
    input.onchange = () => {
      const v = input.value.trim();
      if (!v || v === input.dataset.mask) { input.value = input.dataset.mask; return; }
      onDirty(v);
      input.dataset.mask = v.slice(0, 6) + "••••••";
      input.value = input.dataset.mask;
    };
  }

  // 配置体检：凭据有效 / im:message（发消息） / im:chat（拉群列表，群聊才需要）
  async function runAppCheck() {
    const box = q("#rc-appcheck");
    if (!box) return;
    box.innerHTML = `<span class="nm-chk" style="color:#9ca3af">检查中…</span>`;
    try {
      const r = await rcApi("/rc-api/appcheck");
      if (!r.token) { box.innerHTML = `<span class="nm-chk bad">✗ 凭据无效：${nmEsc(r.error || "请检查 App ID / Secret")}</span>`; return; }
      const item = (ok, label) => `<span class="nm-chk ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${label}</span>`;
      const ch = st.channel || "group";
      let html = item(true, "凭据");
      html += item(r.imMessage !== false, "im:message 发消息");
      if (ch === "group") html += item(r.imChat !== false, "im:chat 拉群列表");
      if (r.imMessage === false || (ch === "group" && r.imChat === false)) html += `<span class="nm-chk bad">缺权限：到开放平台开通后点重新检查</span>`;
      box.innerHTML = html;
    } catch (e) { box.innerHTML = `<span class="nm-chk bad">检查失败：${nmEsc(e.message)}</span>`; }
  }

  function renderChannelForm() {
    const ch = st.channel || "off";
    const form = q("#rc-chform");
    if (ch === "off") { form.innerHTML = ""; return; }
    const appRows = `
      <div class="nm-row nm-row-plain"><span class="nm-label">App ID${infoTip("开放平台 → 凭证与基础信息里的 cli_ 开头 ID")}</span><input class="nm-input" id="rc-appid" placeholder="cli_xxxx" value="${nmEsc(st.appIdMask || "")}"></div>
      <div class="nm-row nm-row-plain"><span class="nm-label">App Secret${infoTip("同一页面；只存本机凭据缝，不进仓库不进配置文件")}</span><input class="nm-input" id="rc-sec" type="password" placeholder="${st.appSecretMask ? "已配置 " + nmEsc(st.appSecretMask) + "，输入新值覆盖" : "app secret"}"></div>
      <div class="nm-row nm-row-plain"><span class="nm-label">配置检查${infoTip(ch === "group" ? "群聊需要 im:chat + im:message 权限，且机器人已被拉进群" : "私聊需要 im:message 权限")}</span>
        <span id="rc-appcheck" style="flex:1"></span><button class="nm-btn" id="rc-recheck">重新检查</button></div>`;
    if (ch === "group") {
      form.innerHTML = `
        ${appRows}
        <div class="nm-row nm-row-plain"><span class="nm-label">通知到群${infoTip("用应用身份发到选定的群；或用下面的群机器人 webhook，二选一")}</span>
          <select class="nm-input" id="rc-chat"><option value="">${st.chatId ? "已选：" + nmEsc(st.chatName || st.chatId) : "（点右侧拉取）"}</option></select>
          <button class="nm-btn" id="rc-fetchchats">拉取群列表</button></div>
        <div class="nm-row nm-row-plain"><span class="nm-label">或群机器人${infoTip("群里加「自定义机器人」拿到 webhook 地址即可，不用 App ID")}</span><input class="nm-input" id="rc-hook" placeholder="${st.hasWebhook ? "已配置，重新粘贴即覆盖" : "webhook 地址（最简单，不用 App ID）"}"></div>`;
      wireAppRow(form);
      const chatSel = form.querySelector("#rc-chat");
      chatSel.onchange = () => {
        const opt = chatSel.options[chatSel.selectedIndex];
        act("/rc-api/config", chatSel.value ? "已通知到群：" + (opt ? opt.textContent : "") : "已取消群选择", { notifyChatId: chatSel.value, notifyChatName: opt ? opt.textContent : "" });
      };
      form.querySelector("#rc-fetchchats").onclick = async () => {
        setMsg("拉取群列表中…");
        try {
          const r = await rcApi("/rc-api/chats");
          if (!r.chats || r.chats.length === 0) { setMsg("机器人还不在任何群里——先在飞书里把它拉进一个群再试"); return; }
          chatSel.innerHTML = `<option value="">（不通知到群）</option>` + r.chats.map((c) => `<option value="${nmEsc(c.chatId)}">${nmEsc(c.name)}</option>`).join("");
          if (st.chatId) chatSel.value = st.chatId;
          setMsg("已拉到 " + r.chats.length + " 个群，选择后即保存");
        } catch (e) { setMsg("失败：" + (e.message || e)); }
      };
      const hook = form.querySelector("#rc-hook");
      hook.onchange = () => act("/rc-api/notify-secret", "webhook 地址已保存", { webhookUrl: hook.value.trim() || undefined });
      return;
    }
    // 私聊
    form.innerHTML = `
      ${appRows}
      <div class="nm-row nm-row-plain"><span class="nm-label">接收者${infoTip("open_id 或 union_id（on_ 开头）；开放平台「消息日志」里可查 open_id")}</span><input class="nm-input" id="rc-oid" placeholder="ou_xxxx / on_xxxx" value="${nmEsc(st.openIdMask || "")}"></div>`;
    wireAppRow(form);
    const oid = form.querySelector("#rc-oid");
    bindMasked(oid, st.openIdMask, (v) => act("/rc-api/config", "接收者已保存", { notifyOpenId: v }));
  }

  function wireAppRow(form) {
    const appId = form.querySelector("#rc-appid");
    const sec = form.querySelector("#rc-sec");
    bindMasked(appId, st.appIdMask, (v) => act("/rc-api/config", "App ID 已保存", { notifyAppId: v }));
    sec.onchange = () => {
      const v = sec.value.trim();
      if (v) {
        act("/rc-api/notify-secret", "App Secret 已保存", { appSecret: v });
        // 立即用刚存的值显示掩码占位（不等表单重建）
        sec.placeholder = "已配置 " + v.slice(0, 4) + "••••••，输入新值覆盖";
      }
      sec.value = "";
    };
    const rc = form.querySelector("#rc-recheck");
    if (rc) rc.onclick = () => runAppCheck();
    if (st.appIdMask && st.hasAppSecret) runAppCheck(); // 凭据齐了就自动体检
  }

  let msgTimer = null;
  function setMsg(m) {
    const el = q("#rc-msg");
    if (el) el.textContent = m;
    if (msgTimer) clearTimeout(msgTimer);
    // 消息是反馈不是状态：几秒后自动消失（失败类停留久一点），不常驻页面
    if (m) msgTimer = setTimeout(() => { const el2 = q("#rc-msg"); if (el2) el2.textContent = ""; }, String(m).includes("失败") ? 8000 : 3500);
  }

  async function act(path, pendingMsg, body) {
    setMsg(pendingMsg || "…");
    try {
      const r = await rcApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      setMsg(r && r.error ? "失败：" + r.error : (done2(r) || "完成"));
    } catch (e) { setMsg("失败：" + (e.message || e)); }
    setTimeout(refresh, 400);
  }
  function done2(r) { return r && r.detail ? String(r.detail) : (r && r.ok ? "完成" : undefined); }

  function setEye(on2) {
    const e = q("#rc-reveal");
    if (!e) return;
    e.innerHTML = on2 ? EYE_OFF : EYE_ON;
    e.title = on2 ? "隐藏密码" : "显示密码";
    e.setAttribute("aria-label", on2 ? "隐藏密码" : "显示密码");
  }
  function wirePwRow() {
    const eye = q("#rc-reveal");
    if (!eye) return;
    eye.onclick = async () => {
      if (shown) { shown = false; return refresh(); }
      try { const r = await rcApi("/rc-api/reveal", { method: "POST" }); shown = true; q("#rc-pw").textContent = r.password; setEye(true); setTimeout(() => { shown = false; refresh(); }, 30000); }
      catch (e) { setMsg("失败：" + e.message); }
    };
    q("#rc-copypw").onclick = async () => {
      try { const r = await rcApi("/rc-api/reveal", { method: "POST" }); await navigator.clipboard.writeText(r.password); flashOk(q("#rc-copypw")); }
      catch (e) { setMsg("失败：" + e.message); }
    };
    q("#rc-reset").onclick = () => { if (confirm("重置密码？所有已登录会话将失效，新密码随下次开启通知推送。")) act("/rc-api/reset", "密码已重置"); };
  }

  // 通知总开关 + 会话有效期（一次接线，状态由 refresh 刷新）
  q("#rc-ntfy").onclick = () => {
    const cur = st ? (st.channel || "off") : "off";
    const next = cur === "off" ? lastChannel : "off";
    act("/rc-api/config", next === "off" ? "通知已关闭" : "通知已开启", { notifyChannel: next });
  };
  q("#rc-days").onchange = () => act("/rc-api/config", "会话有效期已更新", { sessionDays: parseInt(q("#rc-days").value, 10) || 7 });

  // 环境检查
  rcApi("/rc-api/envcheck").then((e) => {
    const row2 = (name, ok, detail) => `<div class="nm-event">${ok ? "✓" : "✗"} ${name}${detail ? " — " + nmEsc(detail) : ""}</div>`;
    q("#rc-env").innerHTML =
      row2("cloudflared", e.cloudflared.found, e.cloudflared.version || e.cloudflared.path) +
      row2("caddy", e.caddy.found, e.caddy.version || e.caddy.path) +
      row2("Cloudflare 账号", e.cfAccount, "临时隧道免配置，无需注册") +
      (e.tunnelLink ? row2("隧道链路自检", e.tunnelLink.ok, e.tunnelLink.ok ? "HTTP " + e.tunnelLink.status + "，登录页可达" : String(e.tunnelLink.status)) : "") +
      row2("DSH 会话密钥（远程登录免二次校验）", e.dshSecret, e.dshSecret ? "" : "未读取到");
  }).catch(() => { q("#rc-env").innerHTML = "管理面未连接，暂无法执行环境检查。"; });

  refresh();
  const poll = setInterval(refresh, 5000);
  return () => { clearInterval(poll); if (cleanupRemotePoll) cleanupRemotePoll(); };
}

// ---------- 详情页区段：远程访问管理页 ----------
// 市场页（Plugins → Nano Market）由 @oh-summy/nano-market 提供；本插件不再占页签，
// 而是在自己的详情页里给出远程访问的完整管理面（隧道、密码、飞书通知）。

const PACKAGE = "@oh-summy/dsh-remote";

function mountRemoteManager(container) {
  const shell = nmShell(container);
  try {
    return renderRemoteDetail(shell, "");
  } catch (e) {
    shell.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px">dsh-remote 管理页挂载失败：${nmEsc((e && e.message) || e)}</div>`;
    return undefined;
  }
}

// ---------- 槽位注册 ----------

const inject = ["slots"];

function apply(ctx) {
  if (!ctx.slots) return;
  // 配置走 plugins.bundle.config：宿主把它排在「来源信息」之上；
  // 旧用的 plugins.detail.section 会被排在「来源信息」之下——正是用户要纠正的顺序。
  // 按包名 key 注册，只在 dsh-remote 的详情页渲染本页。
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: PACKAGE,
    inject: () => ({}),
  }, function DshRemoteConfigCard(props) {
    // 宿主对 keyed 配置槽以 view:"page" 渲染（整块管理页）；
    // view:"summary"（行内一句话）不画管理面，交给宿主条目描述兜底。
    const view = props.view;
    const [node, setNode] = React.useState(null);
    React.useEffect(() => {
      if (view === "summary" || !node) return undefined;
      let cleanup;
      try { cleanup = mountRemoteManager(node); }
      catch (e) {
        node.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px;white-space:pre-wrap">dsh-remote 挂载失败：${nmEsc((e && e.stack) || e)}</div>`;
      }
      // 离开详情页时停掉轮询与定时器，避免后台空转。
      return () => { if (typeof cleanup === "function") cleanup(); };
    }, [view, node]);
    if (view === "summary") return null;
    return h("div", { style: { display: "contents" }, ref: setNode });
  }));
}
