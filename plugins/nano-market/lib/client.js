window.__ModuleLoader__.load({
	id: "@oh-summy/nano-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const MARKET_SNAPSHOT = {"entries":[{"name":"@oh-summy/dsh-remote","title":{"en":"dsh-remote","zh":"dsh-remote 远程访问"},"description":{"en":"Remote access to your local DSH via a Cloudflare quick tunnel with a password gate and Feishu notifications (group or DM).","zh":"通过 Cloudflare 临时隧道 + 密码门远程访问本机 DSH；链接变化自动推送到飞书（群聊/私聊），内置权限体检与环境自检。"},"icon":"https://oh-summy.github.io/dsh-nano-market/icons/dsh-remote.svg","versions":[{"version":"0.4.0","engines":{"dsh":">=0.2.1-rc.4 || >=0.2.2-0"},"install":{"spec":"git+https://github.com/oh-summy/dsh-nano-market.git#43f45eff17577fa4208d96c0a424c2042c85d781"}}],"defaultVersion":"0.4.0"},{"name":"@oh-summy/connect-lark","title":{"en":"connect-lark","zh":"connect-lark 飞书桥接"},"description":{"en":"Feishu/Lark long-connection bridge for DSH: forwards messages to local DSH agents with streaming rich cards, image support, and workspace-aware replies.","zh":"飞书/Lark 长连接桥接 DSH：把飞书消息接到本地 DSH agent，流式富卡片回复，支持图片和工作区。"},"icon":"https://oh-summy.github.io/dsh-nano-market/icons/connect-lark.svg","versions":[{"version":"0.3.0","engines":{"dsh":">=0.2.1-rc.4 || >=0.2.2-0"},"install":{"spec":"git+https://github.com/oh-summy/dsh-nano-market.git#773f1536d386d8d00e6347744868c50669747605"}}],"defaultVersion":"0.3.0"}]};
		// Nano Market 标签页的纯逻辑（无 React / 无宿主依赖）——
// 单独成文件让测试可以 import 后行为级验证（归一化 → 更新目标选择 → 更新载荷），
// 构建时 build-client.mjs 会剥掉 export 关键字、拼接进客户端包体（client.js 在工厂作用域内直接可见）。

// 快照与宿主搜索结果归一成同一形状：名字、描述、图标、版本与安装规格。
// versions[].compatibility 必须保留——宿主用它说明该版本与运行中的 DSH 是否兼容。
// versions[].update 必须保留——宿主对已安装插件算好的更新资格（布尔）：
//   只有「同仓库同目录、目标版本更高、bundle.update === git」的版本才会是 true；
//   「更新」按钮的资格判定完全以它为准，npm 源与跨仓库版本天然不会出现。
function normalizeEntry(raw) {
  const versions = (raw?.versions || []).map((version) => ({
    version: version.version,
    engines: version.engines,
    install: version.install,
    update: version.update,
    compatibility: version.compatibility,
  }));
  return {
    name: raw?.name,
    title: raw?.title,
    description: raw?.description,
    icon: raw?.icon,
    versions,
    // 宿主的 defaultVersion 缺席 = 没有任何兼容版本；回退 versions[0] 只为把
    // 该版本（连同它的 compatibility=false）摆上台面，安装按钮会被门控禁用。
    defaultVersion: raw?.defaultVersion || versions[0]?.version,
    // 宿主算好的安装状态（权威）：有它就用它，没有（快照路径）才自己按本机清单推。
    installation: raw?.installation,
  };
}

function normalizeEntries(raws) {
  return (raws || []).map(normalizeEntry);
}

// 官方 Discover 的 installable() 同规则：兼容，或该精确组合已被豁免。
// 快照路径没有 compatibility 字段（构建期无法判定），交给宿主安装弹窗把关。
function installable(compatibility) {
  return compatibility === undefined || compatibility.compatible === true || compatibility.exempted === true;
}

function presentedVersion(entry) {
  return entry.versions?.find((item) => item.version === entry.defaultVersion) || entry.versions?.[0];
}

function prerelease(version) {
  return version.split("+")[0]?.includes("-") === true;
}

// 官方 plugin-market 的 updateTarget 同规则：对外展示的版本优先，
// 它不可更新（或未装本机清单没得比）时找第一个非预发布的可更新版本。
function updateTarget(entry) {
  const updatable = (version) => version.update && installable(version.compatibility);
  const presented = presentedVersion(entry);
  return updatable(presented) ? presented : entry.versions?.find((version) => updatable(version) && !prerelease(version.version));
}

// 「更新」按钮的载荷 = PluginTabUpdate（slot 契约）：
//   spec 用目标版本的 install.spec（官方 DiscoverSection 同一取法），
//   update 只是宿主算好的资格布尔，不带 spec。
// 无合格目标 / 无 install 规格 / 非本市场更新的形态 → null（调用方不渲染按钮）。
function updatePayloadOf(entry) {
  const target = updateTarget(entry);
  if (!target?.update || !target.install?.spec) return null;
  return { packageName: entry.name, version: target.version, spec: target.install.spec };
}

// ---------- 首屏状态缓存（localStorage）校验 ----------
// 缓存只负责「看得对」（视觉水合）；启停/更新的操作资格由本轮实时数据决定。
// 结构不完整、超过 TTL、savedAt 来自未来（跨设备时钟漂移）一律视为无缓存。
const STATE_CACHE_TTL = 30 * 60 * 1000;
function parseStateCache(raw, now = Date.now(), ttlMs = STATE_CACHE_TTL) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = raw.entries;
  const bundles = raw.bundles;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (!bundles || typeof bundles !== "object" || Array.isArray(bundles)) return null;
  if (!Number.isFinite(raw.savedAt) || now - raw.savedAt > ttlMs || raw.savedAt > now + 60_000) return null;
  return { entries, bundles, savedAt: raw.savedAt };
}
// 开关锁定条件单一实现：忙、只读、清单读取失败、宿主内置、未装入、本轮实时清单未确认——都不得操作
// （审查 P1-2 + P1-3：缓存只负责视觉水合，操作资格等本轮 listBundles 返回）。
function switchLockedOut({ working, locked, status, readFailed, fresh }) {
  return Boolean(working || locked || readFailed || !fresh || status === "provided" || status === "not-installed");
}

// Nano Market — Plugins 页的专属页签（plugins.tab，与官方 Discover 同机制）。
//
// 生命周期模型（负责人 2026-11-23 拍板）：安装 Nano Market = 本市场全部插件随即就位；
// 每个插件只有两种操作——打开（启用开关）与更新（有新版本时行内按钮，走宿主更新对话框）。
// 不提供单独的安装/卸载入口：卸载 Nano Market 后软链悬空、命令自然失效，无需在这里重复管理。
// 整卡点击交给宿主（openPackage）打开官方插件详情页——那里由宿主渲染配置表单与 detail 区段。
//
// 视觉：这一页用宿主的原语（Switch / Tag / Button /
// PluginArtworkDefault）和宿主的设计令牌（--dsw-*），版式照着宿主「已安装」页签的
// 卡片抄，所以两页看起来是同一套东西。
//
// 首屏：条目来自构建期打进包里的市场快照（scripts/gen-snapshot.mjs），零网络；
// 宿主那边配置了本市场的索引源时，后台再搜索刷新（装不了时以快照为准）。
const { createElement: h, useState, useEffect, useCallback, useRef } = React;
// 多子元素必须写进 props.children（该运行时忽略第三个数组参数）——用官方的 jsx 运行时。
const { jsx, jsxs } = require("react/jsx-runtime");
const P = require("@deepseek-ai/dsh-client-ui-primitives");

const NS = "nanoMarket";

// 本市场自己的索引。市场条目由 catalog/entries.jsonl 生成，install spec 已由宿主算好。
const MARKET_INDEX = "https://oh-summy.github.io/dsh-nano-market/index.json";

// 构建期内联的市场快照；源码形态下没有它（空列表，等宿主搜索）。
const SNAPSHOT = typeof MARKET_SNAPSHOT !== "undefined" ? MARKET_SNAPSHOT : { entries: [] };

const zh = {
  title: "Nano Market",
  groupTitle: "本市场",
  switchAria: "{name} 的启用状态",
  stateInstalledOff: "未启用",
  stateUpdate: "可更新",
  update: "更新",
  updateTitle: "更新 {name} {version}",
  empty: "这个市场还没有注册任何插件。",
  unknownState: "读取已安装清单失败，暂不显示启用状态。",
  retry: "重试",
  retrying: "重试中…",
  marketRefreshFailed: "市场索引暂时读不到：",
  cancelled: "操作已取消。",
  restartRequired: "已保存，重启 DSH 后生效。",
  errorUnknown: "操作没有完成，请到「已安装」页查看详情。",
  done: "完成",
  enableFailed: "启用失败",
  disableFailed: "停用失败",
  readOnlyManagement: "这个插件由宿主管理，不能从这里启停。",
  readOnlyUnaddressable: "这个插件读取不到，不能从这里启停。",
  overridden: "变更已保存；运行中的实例由其他机制接管，重启 DSH 后按配置生效。",
  reasonManagementRequired: "这个插件由宿主管理，不能这样启停。",
  reasonUnaddressable: "读不到这个插件，无法启停。",
  reasonUnknownPlugin: "DSH 不认识这个插件，它可能已被卸载。",
  reasonInvalidSpec: "安装规格无效。",
  reasonAlreadyInstalled: "这个插件已经安装过了。",
  reasonAmbiguousInstall: "这个规格对应的插件不止一个，无法确定装哪个。",
  reasonNotBundle: "这个包不声明 dsh.bundle，不能作为插件安装。",
  reasonNotRemovable: "这个插件由 DSH 安装自带，不能移除。",
  reasonStopProfile: "先停止正在运行的会话或任务，再试一次。",
  reasonBundleInUse: "这个插件正在被使用，暂时不能这样操作。",
  reasonStaleApproval: "构建脚本授权已过期，请重新授权后重试。",
  reasonIncompatibleVersion: "运行中的 DSH 版本不满足这个插件的版本要求。",
  reasonOperationError: "操作没有完成。",
};
const en = {
  title: "Nano Market",
  groupTitle: "This market",
  switchAria: "{name} enable state",
  stateInstalledOff: "Not enabled",
  stateUpdate: "Update available",
  update: "Update",
  updateTitle: "Update {name} {version}",
  empty: "This market has no plugins yet.",
  unknownState: "The installed list could not be read, so the enable state is hidden.",
  retry: "Retry",
  retrying: "Retrying…",
  marketRefreshFailed: "The market index could not be read: ",
  cancelled: "Cancelled.",
  restartRequired: "Saved. It takes effect after DSH restarts.",
  errorUnknown: "The operation did not finish. See the Installed page for details.",
  done: "Done",
  enableFailed: "Could not enable",
  disableFailed: "Could not disable",
  readOnlyManagement: "The Host manages this plugin; it cannot be toggled here.",
  readOnlyUnaddressable: "This plugin cannot be read, so it cannot be toggled here.",
  overridden: "Saved. The running instance is managed elsewhere; it takes effect after DSH restarts.",
  reasonManagementRequired: "The Host manages this plugin; it cannot be toggled here.",
  reasonUnaddressable: "This plugin cannot be read, so it cannot be toggled.",
  reasonUnknownPlugin: "DSH does not know this plugin; it may have been uninstalled.",
  reasonInvalidSpec: "The install spec is invalid.",
  reasonAlreadyInstalled: "This plugin is already installed.",
  reasonAmbiguousInstall: "The spec matches more than one plugin; none was chosen.",
  reasonNotBundle: "The package declares no dsh.bundle, so it cannot install as a plugin.",
  reasonNotRemovable: "This plugin ships with the DSH installation and cannot be removed.",
  reasonStopProfile: "Stop the running sessions or tasks first, then try again.",
  reasonBundleInUse: "This plugin is in use right now; try again later.",
  reasonStaleApproval: "The build-script approval is stale; approve the scripts again and retry.",
  reasonIncompatibleVersion: "The running DSH version does not satisfy this plugin's requirement.",
  reasonOperationError: "The operation did not finish.",
};

// 版式与宿主「已安装」页签的卡片一致：扁平列表、48px 图标、标题一行、描述一行、右侧开关。
const CSS = `
.nmk-panel{display:flex;flex-direction:column;gap:24px}
.nmk-group{display:flex;flex-direction:column;gap:8px}
.nmk-groupHead{display:flex;align-items:center;gap:8px}
.nmk-groupTitle{flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.nmk-cards{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nmk-card{border-radius:var(--dsw-radius-xl);min-width:0;margin:0 -8px}
.nmk-cardLink{position:relative}
.nmk-cardLink:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nmk-cardHead{display:flex;align-items:center;gap:14px;padding:8px}
.nmk-cardIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);width:48px;height:48px;color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;align-items:center;justify-content:center}
.nmk-packageImage{object-fit:contain}
.nmk-cardMain{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}
.nmk-titleRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.nmk-cardTitle{font-size:14px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nmk-cardOpen{max-width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;padding:0;font-size:14px;font-weight:500;line-height:20px}
.nmk-cardOpen:after{content:"";border-radius:var(--dsw-radius-xl);position:absolute;inset:0}
.nmk-cardOpen:focus-visible{outline:none}
.nmk-cardOpen:focus-visible:after{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.nmk-cardDesc{color:var(--dsw-alias-label-tertiary);-webkit-line-clamp:1;-webkit-box-orient:vertical;font-size:13px;line-height:18px;display:-webkit-box;overflow:hidden;margin:0}
.nmk-cardEnd{z-index:1;flex:none;display:inline-flex;align-items:center;gap:8px;position:relative}

.nmk-versionTag{font-variant-numeric:tabular-nums;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nmk-statusTag{height:18px;padding:0 7px;font-size:10px;line-height:1;flex:none}
.nmk-msg{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}
.nmk-msg.err{color:var(--dsw-alias-state-error-primary)}
.nmk-notice{display:flex;align-items:center;gap:10px;margin:0;padding:9px 12px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6}
.nmk-notice>span{flex:1;min-width:0}
.nmk-retry{flex:none;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;padding:2px 6px;border-radius:var(--dsw-radius-xs)}
.nmk-retry:disabled{opacity:.5;cursor:default}
.nmk-retry:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.nmk-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:12px 0}
`;

// 市场条目的标题/描述是双语的：优先用宿主的本地化解析，退回自己按语言取。
function localized(text, lang) {
  if (typeof text === "string") return text;
  if (!text) return "";
  return text[lang] || text.zh || text.en || "";
}

// 宿主的 readOnlyReason 是机器码，转成人话。
function readOnlyText(code, t) {
  if (code === "management-required") return t("readOnlyManagement");
  if (code === "unaddressable") return t("readOnlyUnaddressable");
  return t("errorUnknown");
}

// ChangeResult.error.code（ManagementError）的全集，逐码给一句人话；
// 与宿主 managementText 同一判定次序：operation-error 优先说宿主的 diagnostic。
const ERROR_CODE_KEYS = {
  "management-required": "reasonManagementRequired",
  "unaddressable": "reasonUnaddressable",
  "unknown-plugin": "reasonUnknownPlugin",
  "invalid-spec": "reasonInvalidSpec",
  "already-installed": "reasonAlreadyInstalled",
  "ambiguous-install": "reasonAmbiguousInstall",
  "not-bundle": "reasonNotBundle",
  "not-removable": "reasonNotRemovable",
  "stop-profile": "reasonStopProfile",
  "bundle-in-use": "reasonBundleInUse",
  "stale-approval": "reasonStaleApproval",
  "incompatible-version": "reasonIncompatibleVersion",
  "operation-error": "reasonOperationError",
};

function managementText(error, t) {
  const code = error?.code;
  if (code === "operation-error") return error.diagnostic || t("reasonOperationError");
  const key = ERROR_CODE_KEYS[code];
  if (key === undefined) return error?.diagnostic || t("errorUnknown");
  return t(key);
}

// 图标加载失败时回退到宿主默认插件图形，不留碎图或空框（远端 icons 偶发不可达）。
function CardIcon({ src }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return jsx(P.PluginArtworkDefault, { size: 48 });
  return jsx("img", { className: "nmk-packageImage", src, alt: "", width: 48, height: 48, onError: () => setFailed(true) });
}

/** 一张市场卡片：与宿主「已安装」页签的卡片同构。 */
function MarketCard({ entry, bundle, t, resolve, busy, stateKnown, readFailed, freshConfirmed, onToggle, onOpen, update }) {
  const working = busy === entry.name;
  const title = resolve(entry.title) || entry.name || "";
  const version = entry.versions?.find((item) => item.version === entry.defaultVersion) || entry.versions?.[0];
  // 启停状态只看本机已安装清单（宿主 installation.status 只说装没装，不分启用/停用）。
  const status = stateKnown
    ? bundle?.installed
      ? (bundle.enabled ? "enabled" : "installed-off")
      : (bundle?.availability === "installation" ? "provided" : "not-installed")
    : "unknown";
  // 更新资格单一事实源：updatePayload 非空 ⇔ 徽章出现 ⇔ 按钮可渲染（审查 P2：不再两处各判一遍）。
  const canUpdate = entry.installation?.status === "update-available";
  const installed = status === "enabled" || status === "installed-off";
  const locked = bundle?.readOnlyReason !== undefined || (bundle?.error !== undefined && status !== "enabled");
  // 更新资格单一事实源：updatePayload 非空 ⇔ 徽章出现 ⇔ 按钮可渲染（审查 P2：不再两处各判一遍）。
  const updateTargetPayload = canUpdate && installed ? updatePayloadOf(entry) : null;
  const updateBadge = updateTargetPayload ? jsx(P.Tag, { tone: "info", className: "nmk-statusTag", children: t("stateUpdate") }) : null;
  // 图标优先用本机已安装插件的 manifest 图标（宿主读出来的 data:URL），
  // 其次用市场条目里的图标，都没有（或加载失败）就用宿主的默认插件图形。
  const iconSource = bundle?.meta?.icon || entry.icon;
  const artwork = jsx(CardIcon, { src: iconSource });
  const titleRow = jsxs("div", { className: "nmk-titleRow", children: [
    installed
      ? jsx("button", { type: "button", className: "nmk-cardOpen nmk-cardTitle", onClick: onOpen, children: title })
      : jsx("span", { className: "nmk-cardTitle", children: title }),
    (bundle?.version || version?.version) ? jsx("span", { className: "nmk-versionTag", children: bundle?.version || version?.version }) : null,
    // 唯一的状态徽章：「未启用」——解释开关为什么不起作用。打开态与加载态不显示任何徽章。
    status === "installed-off" ? jsx(P.Tag, { tone: "warning", className: "nmk-statusTag", children: t("stateInstalledOff") }) : null,
    updateBadge,
  ] });
  const main = jsx("div", { className: "nmk-cardMain", children: [
    titleRow,
    jsx("p", { className: "nmk-cardDesc", children: resolve(entry.description) }),
  ] });
  const switchEl = jsx(P.Switch, {
    checked: status === "enabled",
    label: t("switchAria", { name: title }),
    // 未装入的个别插件（罕见形态：跟随 nano-market 更新时装入）开关禁用；
    // 清单读取失败也禁用（不按陈旧/未知状态操作，审查 P1-2）；
    // 首屏水合窗口（无错误、实时数据未到）不禁用——负责人要求加载期无占位。
    disabled: switchLockedOut({ working, locked, status, readFailed, fresh: freshConfirmed }),
    ...(bundle?.readOnlyReason === undefined ? {} : { title: readOnlyText(bundle.readOnlyReason, t) }),
    onChange: onToggle,
        });
  // 已安装且有更新：宿主 slot 契约给了 update 执行器（走页面自带的更新对话框）就上按钮；
  // 没给（老版宿主）则维持现状——只有「可更新」徽章，不渲染点不动的假按钮。
  // 载荷 = PluginTabUpdate（slot 契约）；spec 用目标版本的 install.spec（官方 DiscoverSection 同一取法）。
  // update 执行器缺失（老版宿主）→ null，按钮不渲染，退化为「可更新」徽章。
  const updateButton = updateTargetPayload && typeof update === "function"
    ? jsx(P.Button, {
        variant: "outline",
        size: "sm",
        disabled: working || !freshConfirmed, // 更新同样等本轮实时清单（审查 P1-3：缓存只管视觉）
        "aria-label": t("updateTitle", { name: title, version: updateTargetPayload.version }),
        onClick: () => update(updateTargetPayload),
        children: t("update"),
      })
    : null;
  // 更新按钮在开关左侧同一行（负责人指定的版式）。
  const end = updateButton ? [updateButton, switchEl] : switchEl;
  const head = jsx("div", { className: "nmk-cardHead", children: [
    jsx("span", { className: "nmk-cardIcon", children: artwork }),
    main,
    jsx("div", { className: "nmk-cardEnd", children: end }),
  ] });
  return jsxs("li", {
    className: "nmk-card nmk-cardLink",
    key: entry.name,
    "data-plugin-package": entry.name,
    "data-plugin-status": status,
    children: head,
  });
}

/** 渲染失败时给一句人话，而不是一片空白。 */
class TabBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return h("div", { className: "nmk-notice", children: String((this.state.error && this.state.error.message) || this.state.error) });
    }
    return this.props.children;
  }
}

// 上次实时状态的 localStorage 读写（跨宿主重启/页面刷新消除首帧闪动；失败静默退化）。
function readStateCache() {
  try {
    const v = JSON.parse(localStorage.getItem("nmk-state-cache") || "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function writeStateCache(patch) {
  try {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem("nmk-state-cache") || "null"); } catch { /* 损坏即弃 */ }
    localStorage.setItem("nmk-state-cache", JSON.stringify({ ...(prev && typeof prev === "object" ? prev : {}), ...patch, savedAt: Date.now() }));
  } catch { /* private mode 等 */ }
}
// parseStateCache/switchLockedOut 在 market-logic.js（构建时并入），测试直接覆盖纯函数。

function NanoMarketTab(props) {
  const t = props.t;
  const ctx = props.ctx;
  // 宿主把本地化解析交给每个槽位；没有就按当前语言自己取。
  const lang = ctx?.locale?.getSnapshot?.()?.active === "en" ? "en" : "zh";
  const resolve = useCallback((text) => ctx?.locale?.resolveText?.(text) || localized(text, lang), [ctx, lang]);

  // 首屏水合：仅当缓存通过校验（结构 + TTL）才用其「视觉呈现」，操作资格等本轮实时数据（freshConfirmed）。
  // 没有有效缓存就回退构建期快照；开关在数据到达前禁用（读取失败也禁用——不按陈旧/未知状态操作）。
  const cachedState = parseStateCache(readStateCache());
  const [entries, setEntries] = useState(() => normalizeEntries(cachedState?.entries ?? SNAPSHOT.entries));
  const [bundles, setBundles] = useState(() => cachedState?.bundles ?? {});
  const [bundlesLoaded, setBundlesLoaded] = useState(() => Boolean(cachedState));
  const [freshConfirmed, setFreshConfirmed] = useState(false); // 本轮 listBundles+search 都返回后才允许操作
  const [bundleError, setBundleError] = useState("");
  const [marketError, setMarketError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const fetchGen = useRef(0); // 请求代次：只采纳最新一次请求的结果（审查 P1-4）
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // 状态提示是瞬时的：过几秒自己消失，不长期占着版面。
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [message]);

  // 本机已安装清单（本地 IPC，毫秒级）。
  const refreshBundles = useCallback(async () => {
    const gen = ++fetchGen.current;
    try {
      const answer = await ctx.remote.pluginManager.listBundles();
      if (gen !== fetchGen.current || !mountedRef.current) return; // 过期响应/已卸载：不覆盖新状态
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "listBundles failed");
      const byName = {};
      for (const bundle of answer.value || []) byName[bundle.name] = bundle;
      setBundles(byName);
      setBundleError("");
      setBundlesLoaded(true);
      setFreshConfirmed(true);
      writeStateCache({ bundles: byName });
    } catch (error) {
      if (gen !== fetchGen.current || !mountedRef.current) return;
      // 读不到清单 = 不知道谁装了：开关禁用（不按陈旧/未知状态操作），只说明原因。
      setBundleError(error?.message || String(error));
      setBundlesLoaded(true);
      setFreshConfirmed(false);
    }
  }, [ctx]);

  // 市场索引（网络）：只有宿主那边配了本市场的索引源才搜；没配就用快照，不报错。
  const refreshMarket = useCallback(async () => {
    const gen = ++fetchGen.current;
    try {
      const indexes = await ctx.remote.pluginMarket.listIndexes();
      const sources = indexes?.value ?? [];
      const configured = Array.isArray(sources)
        ? sources.some((item) => item?.url === MARKET_INDEX)
        : false;
      if (!configured) return null;
      const answer = await ctx.remote.pluginMarket.search(MARKET_INDEX, { sort: { kind: "index" }, offset: 0, limit: 100 });
      if (gen !== marketGen.current || !mountedRef.current) return null;
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "market search failed");
      const fresh = normalizeEntries(answer.value?.entries || []);
      if (gen !== marketGen.current || !mountedRef.current) return null;
      if (fresh.length) {
        setEntries(fresh);
        writeStateCache({ entries: fresh });
      } else {
        // 空结果：清缓存并回退构建期快照，不让陈旧缓存冒充当前市场（审查 P1-3）。
        setEntries(normalizeEntries(SNAPSHOT.entries));
        try { localStorage.removeItem("nmk-state-cache"); } catch { /* 无缓存时忽略 */ }
      }
      if (gen !== marketGen.current || !mountedRef.current) return null;
      setMarketError("");
      return fresh;
    } catch (error) {
      if (gen !== marketGen.current || !mountedRef.current) return null;
      // 没有网络也不影响浏览：快照已经画在屏幕上了。
      setMarketError(t("marketRefreshFailed") + (error?.message || String(error)));
      return null;
    }
  }, [ctx]);

  useEffect(() => {
    void refreshBundles();
    void refreshMarket();
  }, [refreshBundles, refreshMarket]);

  // 两条横幅共用一个重试入口：清单与索引一起补读，进行中两个按钮同时禁用。
  const [refreshing, setRefreshing] = useState(false);
  const retryReads = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshBundles();
      await refreshMarket();
    } finally {
      setRefreshing(false);
    }
  }, [refreshBundles, refreshMarket]);

  // 让卡片不停在旧状态的整组事件：装完/启停完（plugin-manager/changed）、
  // 索引源配置变了（plugin-market/changed，官方 Discover 也订它）、
  // 连接重置后本机清单可能过期（connection/reset，与官方已安装页同款）。
  useEffect(() => {
    const disposers = [
      ctx.remote.$on("plugin-manager/changed", () => {
        void refreshBundles();
        void refreshMarket();
      }),
      ctx.remote.$on("plugin-market/changed", () => {
        void refreshMarket();
      }),
      typeof ctx.on === "function"
        ? ctx.on("connection/reset", () => {
            void refreshBundles();
          })
        : undefined,
    ];
    return () => {
      for (const dispose of disposers) if (typeof dispose === "function") dispose();
    };
  }, [ctx, refreshBundles, refreshMarket]);

  async function run(name, task, failKey) {
    setBusy(name);
    setMessage(null);
    try {
      const result = await task();
      // 宿主契约：传输层失败是 {ok:false,error}；业务结局看 value.application。
      if (!result || result.ok === false) {
        const reason = result?.error?.message || t("errorUnknown");
        setMessage({ text: t(failKey) + "：" + reason, tone: "error" });
        return;
      }
      const outcome = result.value?.application;
      if (outcome === "failed") {
        setMessage({ text: t(failKey) + "：" + managementText(result.value?.error, t), tone: "error" });
        return;
      }
      if (outcome === "cancelled") setMessage({ text: t("cancelled"), tone: "info" });
      else if (outcome === "overridden") setMessage({ text: t("overridden"), tone: "info" });
      else if (outcome === "restart-required") setMessage({ text: t("restartRequired"), tone: "info" });
      else setMessage({ text: t("done"), tone: "info" });
    } catch (error) {
      setMessage({ text: t(failKey) + "：" + (error?.message || t("errorUnknown")), tone: "error" });
    } finally {
      setBusy("");
      // 只刷新本机清单：市场索引刚取过，不必为一次开关再走一趟网络。
      await refreshBundles();
    }
  }

  const toggle = (entry, next) => {
    void run(entry.name, () => ctx.remote.pluginManager.setBundleEnabled(entry.name, next), next ? "enableFailed" : "disableFailed");
  };

  return jsxs("div", { className: "nmk-panel", children: [
    jsx("style", { children: CSS }),
    jsxs("section", { className: "nmk-group", children: [
      jsxs("div", { className: "nmk-groupHead", children: [
        jsx("h4", { className: "nmk-groupTitle", children: t("groupTitle") }),
      ] }),
      entries.length === 0
        ? jsx("div", { className: "nmk-empty", children: t("empty") })
        : jsx("ul", { className: "nmk-cards", children: entries.map((entry) => jsx(MarketCard, {
            entry,
            bundle: bundles[entry.name],
            t,
            resolve,
            busy,
            stateKnown: bundlesLoaded && !bundleError,
            readFailed: Boolean(bundleError),
            freshConfirmed,
            key: entry.name,
            onToggle: (next) => toggle(entry, next),
            onOpen: () => props.openPackage(entry.name),
            update: typeof props.update === "function" ? (target) => props.update(target) : undefined,
          })) }),
    ] }),
    bundleError ? jsxs("div", { className: "nmk-notice", children: [
      jsx("span", { children: t("unknownState") + "（" + (bundleError || "") + "）" }),
      jsx("button", { type: "button", className: "nmk-retry", disabled: refreshing, onClick: () => void retryReads(), children: refreshing ? t("retrying") : t("retry") }),
    ] }) : null,
    marketError ? jsxs("div", { className: "nmk-notice", children: [
      jsx("span", { children: marketError }),
      jsx("button", { type: "button", className: "nmk-retry", disabled: refreshing, onClick: () => void retryReads(), children: refreshing ? t("retrying") : t("retry") }),
    ] }) : null,
    message ? jsx("div", { className: "nmk-msg" + (message.tone === "error" ? " err" : ""), children: message.text }) : null,
  ] });
}

const inject = ["slots", "locale", "remote", "remote.pluginMarket", "remote.pluginManager"];

function apply(ctx) {
  if (!ctx.slots) return;
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "nano-market: dictionaries");
  ctx.slots.inject("plugins.tab", () => ctx.slots.register({
    name: "plugins.tab",
    id: "nano-market",
    order: -1,
    label: () => t("title"),
    // 声明字典命名空间，宿主才会把绑定好的翻译函数注进 props。
    locale: NS,
  }, function NanoMarketTabEntry(props) {
    // 页签的宿主 props 有 install / update / openPackage（slot 契约 PluginTabProps）；ctx 由我们显式带进去，
    // 翻译函数优先用宿主注入的那份（它会随语言切换刷新）。
    return h(TabBoundary, { children: h(NanoMarketTab, { ...props, t: props.t ?? t, ctx }) });
  }));
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
