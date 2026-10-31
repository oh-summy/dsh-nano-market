window.__ModuleLoader__.load({
	id: "@oh-summy/nano-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const MARKET_SNAPSHOT = {"entries":[{"name":"@oh-summy/dsh-remote","title":{"en":"dsh-remote","zh":"dsh-remote 远程访问"},"description":{"en":"Remote access to your local DSH via a Cloudflare quick tunnel with a password gate and Feishu notifications (group or DM).","zh":"通过 Cloudflare 临时隧道 + 密码门远程访问本机 DSH；链接变化自动推送到飞书（群聊/私聊），内置权限体检与环境自检。"},"icon":"https://oh-summy.github.io/dsh-nano-market/icons/dsh-remote.svg","versions":[{"version":"0.2.0","engines":{"dsh":">=0.2.1-rc.2 || >=0.2.2-0"},"install":{"spec":"git+https://github.com/oh-summy/dsh-nano-market.git#4d03c081c3e79cf500f79412b4e1281efbc521d0"}}],"defaultVersion":"0.2.0"},{"name":"@oh-summy/connect-lark","title":{"en":"connect-lark","zh":"connect-lark 飞书桥接"},"description":{"en":"Feishu/Lark long-connection bridge for DSH: forwards messages to local DSH agents with streaming rich cards, image support, and workspace-aware replies.","zh":"飞书/Lark 长连接桥接 DSH：把飞书消息接到本地 DSH agent，流式富卡片回复，支持图片和工作区。"},"icon":"https://oh-summy.github.io/dsh-nano-market/icons/connect-lark.svg","versions":[{"version":"0.1.0","engines":{"dsh":">=0.2.1-rc.4 || >=0.2.2-0"},"install":{"spec":"git+https://github.com/oh-summy/dsh-nano-market.git#3bf790ef09e8d83a0347a2956ec9d646f089af5e"}}],"defaultVersion":"0.1.0"}]};
		// Nano Market — Plugins 页的专属页签（plugins.tab，与官方 Discover 同机制）。
//
// 一级页面：列出本市场注册的插件，按「未安装 → 已安装未启用 → 已启用」三态给出对应操作：
//   未安装        → 安装
//   已安装未启用  → 启用
//   已启用        → 停用（点整张卡片进入插件页面）
// 二级页面：整卡点击交给宿主（openPackage）打开官方插件详情页——
//   那里由宿主渲染 plugins.bundle.config 配置表单与各插件自己的 detail 区段。
// 卸载不在这里做：官方插件页用同样的方式管理启停与卸载，重复一份只会让人多点一次。
//
// 视觉：这一页用宿主的原语（Switch / Tag / Button / RiskConfirmation /
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
  install: "安装",
  switchAria: "{name} 的启用状态",
  stateNotInstalled: "未安装",
  stateInstalledOff: "已安装 · 未启用",
  stateEnabled: "已启用",
  stateProvided: "宿主内置",
  stateUpdate: "可更新",
  empty: "这个市场还没有注册任何插件。",
  unknownState: "读取已安装清单失败，暂不显示启用状态。",
  stateUnknownShort: "状态未知",
  retry: "重试",
  retrying: "重试中…",
  marketRefreshFailed: "市场索引暂时读不到：",
  installTitle: "安装 {name} {version}？",
  installWarning: "插件代码会在本机以你的权限运行。请确认你信任它的来源。",
  installAcknowledge: "我确认信任这个插件的来源",
  installConfirm: "安装",
  installCancel: "取消",
  installUnavailable: "这个插件暂时没有可安装的版本，请稍后再试。",
  cancelled: "操作已取消。",
  restartRequired: "已保存，重启 DSH 后生效。",
  errorUnknown: "操作没有完成，请到「已安装」页查看详情。",
  done: "完成",
  enableFailed: "启用失败",
  disableFailed: "停用失败",
  readOnlyManagement: "这个插件由宿主管理，不能从这里启停。",
  readOnlyUnaddressable: "这个插件读取不到，不能从这里启停。",
  noCompatibleVersion: "没有与运行中的 DSH（{runtime}）兼容的版本。",
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
  install: "Install",
  switchAria: "{name} enable state",
  stateNotInstalled: "Not installed",
  stateInstalledOff: "Installed · not enabled",
  stateEnabled: "Enabled",
  stateProvided: "Bundled with DSH",
  stateUpdate: "Update available",
  empty: "This market has no plugins yet.",
  unknownState: "The installed list could not be read, so the enable state is hidden.",
  stateUnknownShort: "Unknown",
  retry: "Retry",
  retrying: "Retrying…",
  marketRefreshFailed: "The market index could not be read: ",
  installTitle: "Install {name} {version}?",
  installWarning: "The plugin code runs on this machine with your permissions. Make sure you trust its source.",
  installAcknowledge: "I trust the source of this plugin",
  installConfirm: "Install",
  installCancel: "Cancel",
  installUnavailable: "No installable version of this plugin right now. Try again later.",
  cancelled: "Cancelled.",
  restartRequired: "Saved. It takes effect after DSH restarts.",
  errorUnknown: "The operation did not finish. See the Installed page for details.",
  done: "Done",
  enableFailed: "Could not enable",
  disableFailed: "Could not disable",
  readOnlyManagement: "The Host manages this plugin; it cannot be toggled here.",
  readOnlyUnaddressable: "This plugin cannot be read, so it cannot be toggled here.",
  noCompatibleVersion: "No version is compatible with the running DSH ({runtime}).",
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

// 快照与宿主搜索结果归一成同一形状：名字、描述、图标、版本与安装规格。
// versions[].compatibility 必须保留——宿主用它说明该版本与运行中的 DSH 是否兼容。
function normalizeEntry(raw) {
  const versions = (raw?.versions || []).map((version) => ({
    version: version.version,
    engines: version.engines,
    install: version.install,
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

// 官方 Discover 的 installable() 同规则：兼容，或该精确组合已被豁免。
// 快照路径没有 compatibility 字段（构建期无法判定），交给宿主安装弹窗把关。
function installable(compatibility) {
  return compatibility === undefined || compatibility.compatible === true || compatibility.exempted === true;
}

// 图标加载失败时回退到宿主默认插件图形，不留碎图或空框（远端 icons 偶发不可达）。
function CardIcon({ src }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return jsx(P.PluginArtworkDefault, { size: 48 });
  return jsx("img", { className: "nmk-packageImage", src, alt: "", width: 48, height: 48, onError: () => setFailed(true) });
}

/** 一张市场卡片：与宿主「已安装」页签的卡片同构。 */
function MarketCard({ entry, bundle, t, resolve, busy, stateKnown, onToggle, onInstall, onOpen }) {
  const working = busy === entry.name;
  const title = resolve(entry.title) || entry.name || "";
  const version = entry.versions?.find((item) => item.version === entry.defaultVersion) || entry.versions?.[0];
  // 启停状态只看本机已安装清单（宿主 installation.status 只说装没装，不分启用/停用）。
  const status = stateKnown
    ? bundle?.installed
      ? (bundle.enabled ? "enabled" : "installed-off")
      : (bundle?.availability === "installation" ? "provided" : "not-installed")
    : "unknown";
  // 宿主说本机装的是旧版时，额外提示可更新（它只在已装时出现）。
  const canUpdate = entry.installation?.status === "update-available";
  const installed = status === "enabled" || status === "installed-off";
  const locked = bundle?.readOnlyReason !== undefined || (bundle?.error !== undefined && status !== "enabled");
  // 图标优先用本机已安装插件的 manifest 图标（宿主读出来的 data:URL），
  // 其次用市场条目里的图标，都没有（或加载失败）就用宿主的默认插件图形。
  const iconSource = bundle?.meta?.icon || entry.icon;
  const artwork = jsx(CardIcon, { src: iconSource });
  const statusLabel = status === "enabled"
    ? t("stateEnabled")
    : status === "installed-off"
      ? t("stateInstalledOff")
      : status === "provided"
        ? t("stateProvided")
        : status === "unknown"
            ? t("stateUnknownShort")
            : t("stateNotInstalled");
  // 与官方 Discover 同规则：不兼容（且未豁免）的版本不给安装，说明原因。
  const canInstall = installable(version?.compatibility);
  const statusTone = status === "enabled"
    ? "success"
    : status === "installed-off"
      ? "warning"
      : status === "provided"
        ? "neutral"
        : "outline";
  const titleRow = jsxs("div", { className: "nmk-titleRow", children: [
    installed
      ? jsx("button", { type: "button", className: "nmk-cardOpen nmk-cardTitle", onClick: onOpen, children: title })
      : jsx("span", { className: "nmk-cardTitle", children: title }),
    version ? jsx("span", { className: "nmk-versionTag", children: version.version }) : null,
    jsx(P.Tag, { tone: statusTone, className: "nmk-statusTag", children: statusLabel }),
    canUpdate ? jsx(P.Tag, { tone: "info", className: "nmk-statusTag", children: t("stateUpdate") }) : null,
  ] });
  const main = jsx("div", { className: "nmk-cardMain", children: [
    titleRow,
    jsx("p", { className: "nmk-cardDesc", children: resolve(entry.description) }),
  ] });
  const end = status === "not-installed"
    ? (canInstall
      ? jsx(P.Button, { variant: "primary", size: "sm", disabled: working || !stateKnown, onClick: onInstall, children: t("install") })
      : jsx(P.Tooltip, {
          label: t("noCompatibleVersion", { runtime: version?.compatibility?.runtimeVersion ?? "" }),
          side: "bottom",
          portal: true,
          delayMs: 300,
          children: jsx(P.Button, { variant: "primary", size: "sm", "aria-disabled": "true", "aria-label": t("install"), children: t("install") }),
        }))
    : // 清单读不到时开关留在原位但禁用（悬停说明原因），避免整块控件消失造成布局跳动。
      status === "unknown"
      ? jsx(P.Switch, {
          checked: false,
          label: t("switchAria", { name: title }),
          disabled: true,
          title: t("unknownState"),
        })
      : status === "provided"
        ? null
        : jsx(P.Switch, {
          checked: status === "enabled",
          label: t("switchAria", { name: title }),
          disabled: working || locked,
          ...(bundle?.readOnlyReason === undefined ? {} : { title: readOnlyText(bundle.readOnlyReason, t) }),
          onChange: onToggle,
        });
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

function NanoMarketTab(props) {
  const t = props.t;
  const ctx = props.ctx;
  // 宿主把本地化解析交给每个槽位；没有就按当前语言自己取。
  const lang = ctx?.locale?.getSnapshot?.()?.active === "en" ? "en" : "zh";
  const resolve = useCallback((text) => ctx?.locale?.resolveText?.(text) || localized(text, lang), [ctx, lang]);

  // 首屏用快照：零网络，卡片立刻出现。
  const [entries, setEntries] = useState(() => normalizeEntries(SNAPSHOT.entries));
  const [bundles, setBundles] = useState({});
  const [bundleError, setBundleError] = useState("");
  const [marketError, setMarketError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const liveRef = useRef(false);

  // 状态提示是瞬时的：过几秒自己消失，不长期占着版面。
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [message]);

  // 本机已安装清单（本地 IPC，毫秒级）。
  const refreshBundles = useCallback(async () => {
    try {
      const answer = await ctx.remote.pluginManager.listBundles();
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "listBundles failed");
      const byName = {};
      for (const bundle of answer.value || []) byName[bundle.name] = bundle;
      setBundles(byName);
      setBundleError("");
    } catch (error) {
      // 读不到清单 = 不知道谁装了：卡片不给启停/安装操作，只说明原因。
      setBundleError(error?.message || String(error));
    }
  }, [ctx]);

  // 市场索引（网络）：只有宿主那边配了本市场的索引源才搜；没配就用快照，不报错。
  const refreshMarket = useCallback(async () => {
    try {
      const indexes = await ctx.remote.pluginMarket.listIndexes();
      const sources = indexes?.value ?? [];
      const configured = Array.isArray(sources)
        ? sources.some((item) => item?.url === MARKET_INDEX)
        : false;
      if (!configured) return null;
      const answer = await ctx.remote.pluginMarket.search(MARKET_INDEX, { sort: { kind: "index" }, offset: 0, limit: 100 });
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "market search failed");
      const fresh = normalizeEntries(answer.value?.entries || []);
      if (fresh.length) {
        liveRef.current = true;
        setEntries(fresh);
      }
      setMarketError("");
      return fresh;
    } catch (error) {
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

  const askInstall = (entry) => {
    const version = entry.versions?.find((item) => item.version === entry.defaultVersion) || entry.versions?.[0];
    if (!version?.install) {
      setMessage({ text: t("installUnavailable"), tone: "error" });
      return;
    }
    setAcknowledged(false);
    setConfirming({ entry, version });
  };

  const doInstall = async () => {
    if (!confirming) return;
    const { entry, version } = confirming;
    setConfirming(null);
    // 安装前刷新一次：规格与兼容性都取宿主算好的那份（没配索引源时用快照里的）。
    const fresh = liveRef.current ? null : await refreshMarket();
    const target = fresh?.find((item) => item.name === entry.name) || entry;
    const live = target.versions?.find((item) => item.version === target.defaultVersion) || target.versions?.[0];
    if (!live?.install) {
      setMessage({ text: t("installUnavailable"), tone: "error" });
      return;
    }
    props.install({ ...live.install, title: resolve(target.title) || target.name, version: live.version });
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
            stateKnown: !bundleError,
            key: entry.name,
            onToggle: (next) => toggle(entry, next),
            onInstall: () => askInstall(entry),
            onOpen: () => props.openPackage(entry.name),
          })) }),
    ] }),
    bundleError ? jsxs("div", { className: "nmk-notice", children: [
      jsx("span", { children: t("unknownState") }),
      jsx("button", { type: "button", className: "nmk-retry", disabled: refreshing, onClick: () => void retryReads(), children: refreshing ? t("retrying") : t("retry") }),
    ] }) : null,
    marketError ? jsxs("div", { className: "nmk-notice", children: [
      jsx("span", { children: marketError }),
      jsx("button", { type: "button", className: "nmk-retry", disabled: refreshing, onClick: () => void retryReads(), children: refreshing ? t("retrying") : t("retry") }),
    ] }) : null,
    message ? jsx("div", { className: "nmk-msg" + (message.tone === "error" ? " err" : ""), children: message.text }) : null,
    jsx(P.RiskConfirmation, {
      open: Boolean(confirming),
      title: confirming ? t("installTitle", { name: resolve(confirming.entry.title) || confirming.entry.name, version: confirming.version.version }) : "",
      description: t("installWarning"),
      acknowledgeLabel: t("installAcknowledge"),
      cancelLabel: t("installCancel"),
      closeLabel: t("installCancel"),
      confirmLabel: t("installConfirm"),
      acknowledged,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => {
        setConfirming(null);
        setAcknowledged(false);
        setMessage({ text: t("cancelled"), tone: "info" });
      },
      onConfirm: () => void doInstall(),
    }),
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
    // 页签的宿主 props 只有 install / openPackage；ctx 由我们显式带进去，
    // 翻译函数优先用宿主注入的那份（它会随语言切换刷新）。
    return h(TabBoundary, { children: h(NanoMarketTab, { ...props, t: props.t ?? t, ctx }) });
  }));
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
