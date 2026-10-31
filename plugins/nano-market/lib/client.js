window.__ModuleLoader__.load({
	id: "@oh-summy/nano-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const MARKET_SNAPSHOT = {"generatedAt":1793420355,"title":{"en":"oh-summy's DSH Nano Market","zh":"oh-summy 的 DSH 纳米市场"},"entries":[{"name":"@oh-summy/dsh-remote","title":{"en":"dsh-remote","zh":"dsh-remote 远程访问"},"description":{"en":"Remote access to your local DSH via a Cloudflare quick tunnel with a password gate and Feishu notifications (group or DM).","zh":"通过 Cloudflare 临时隧道 + 密码门远程访问本机 DSH；链接变化自动推送到飞书（群聊/私聊），内置权限体检与环境自检。"},"icon":"https://oh-summy.github.io/dsh-nano-market/icons/dsh-remote.svg","author":"oh-summy","homepage":"https://github.com/oh-summy/dsh-nano-market/tree/main/plugins/dsh-remote","repository":{"url":"https://github.com/oh-summy/dsh-nano-market","directory":"plugins/dsh-remote"},"metadata":{"category":"tools","keywords":["dsh","dsh-plugin","remote","tunnel","cloudflare","feishu"],"labels":["mine","notifier","needs-env"]},"versions":[{"version":"0.2.0","publishTimestamp":1792941848,"engines":{"dsh":">=0.2.1-rc.2 || >=0.2.2-0"},"install":{"spec":"git+https://github.com/oh-summy/dsh-nano-market.git#4d03c081c3e79cf500f79412b4e1281efbc521d0"}}]},{"name":"@oh-summy/connect-lark","title":{"en":"connect-lark","zh":"connect-lark 飞书桥接"},"description":{"en":"Feishu/Lark long-connection bridge for DSH: forwards messages to local DSH agents with streaming rich cards, image support, and workspace-aware replies.","zh":"飞书/Lark 长连接桥接 DSH：把飞书消息接到本地 DSH agent，流式富卡片回复，支持图片和工作区。"},"icon":"https://oh-summy.github.io/dsh-nano-market/icons/connect-lark.svg","author":"oh-summy","homepage":"https://github.com/oh-summy/dsh-nano-market/tree/main/plugins/connect-lark","repository":{"url":"https://github.com/oh-summy/dsh-nano-market","directory":"plugins/connect-lark"},"metadata":{"category":"tools","keywords":["dsh","dsh-plugin","connect-lark","feishu","lark","chat"],"labels":["mine","needs-env"]},"versions":[{"version":"0.1.0","publishTimestamp":1793288669,"engines":{"dsh":">=0.2.1-rc.4 || >=0.2.2-0"},"install":{"spec":"git+https://github.com/oh-summy/dsh-nano-market.git#3bf790ef09e8d83a0347a2956ec9d646f089af5e"}}]}]};
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
// 视觉：这一页用宿主的原语（Switch / Tag / Button / PluginArtworkDefault）和宿主的
// 设计令牌（--dsw-*），版式照着宿主「已安装」页签的卡片抄，所以两页看起来是同一套东西。
//
// 首屏：条目来自构建期打进包里的市场快照（scripts/gen-snapshot.mjs），零网络；
// 随后后台用宿主搜索刷新，安装规格始终取宿主算好的那一份。
const { createElement: h, useState, useEffect, useCallback, useRef, Fragment } = React;
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
  loading: "正在读取市场索引…",
  failed: "读取市场索引失败",
  retry: "重试",
  install: "安装",
  enable: "启用",
  disable: "停用",
  uninstall: "卸载",
  switchAria: "{name} 的启用状态",
  stateNotInstalled: "未安装",
  stateInstalledOff: "已安装 · 未启用",
  stateEnabled: "已启用",
  stateProvided: "宿主内置",
  stateUpdate: "可更新",
  empty: "这个市场还没有注册任何插件。",
  busy: "处理中…",
  confirmInstall: "安装 {name} {version}？插件代码会在本机运行。",
  confirmUninstall: "卸载 {name}？该插件提供的功能会随之消失。",
  uninstallFailed: "卸载失败",
  enableFailed: "启用失败",
  disableFailed: "停用失败",
  cancelled: "操作已取消。",
  restartRequired: "已保存，重启 DSH 后生效。",
  errorNotRemovable: "这个插件不能直接卸载，请到「已安装」页处理。",
  errorStopProfile: "当前 profile 不支持热更新，请先停掉 DSH 再卸载。",
  errorBundleInUse: "插件正在被使用，先停用再卸载。",
  errorUnknown: "操作没有完成，请到「已安装」页查看详情。",
  indexMissing: "还没有添加本市场的索引源。请到「发现 → 索引源」添加 {url}，然后回到这里刷新。",
  readingIndex: "正在读取市场索引…",
  installUnavailable: "这个插件暂时没有可安装的版本，请稍后再试。",
  done: "完成",
};
const en = { ...zh };

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
.nmk-notice{margin:0;padding:9px 12px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6}
.nmk-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:12px 0}
`;

function titleOf(entry) {
  const t = entry?.title;
  if (!t) return entry?.name || "";
  return t.zh || t.en || entry.name || "";
}

function descriptionOf(entry) {
  const d = entry?.description;
  if (!d) return "";
  return d.zh || d.en || "";
}

// 快照与宿主搜索结果归一成同一形状：名字、描述、图标、版本与安装规格。
function normalizeEntry(raw) {
  const versions = (raw?.versions || []).map((version) => ({
    version: version.version,
    engines: version.engines,
    install: version.install,
  }));
  return {
    name: raw?.name,
    title: raw?.title,
    description: raw?.description,
    icon: raw?.icon,
    homepage: raw?.homepage,
    versions,
    defaultVersion: raw?.defaultVersion || versions[0]?.version,
  };
}

function normalizeEntries(raws) {
  return (raws || []).map(normalizeEntry);
}

// 与宿主 installationOf 同规则：状态只看本机已安装清单，不看市场缓存。
function stateOf(bundle) {
  if (!bundle) return "not-installed";
  if (!bundle.installed) return bundle.availability === "installation" ? "provided" : "not-installed";
  return bundle.enabled ? "enabled" : "installed-off";
}

function tagTone(state) {
  if (state === "enabled") return "success";
  if (state === "installed-off") return "warning";
  if (state === "provided") return "neutral";
  return "outline";
}

function errorKey(code) {
  if (code === "not-removable") return "errorNotRemovable";
  if (code === "stop-profile") return "errorStopProfile";
  if (code === "bundle-in-use") return "errorBundleInUse";
  return "errorUnknown";
}

/** 一张市场卡片：与宿主「已安装」页签的卡片同构。 */
function MarketCard({ entry, bundle, t, busy, onToggle, onInstall, onOpen }) {
  const state = stateOf(bundle);
  const working = busy === entry.name;
  const title = titleOf(entry);
  const version = entry.versions?.find((item) => item.version === entry.defaultVersion) || entry.versions?.[0];
  const installed = state === "enabled" || state === "installed-off";
  // 宿主保护或读不出的 bundle 不给开关（宿主自己的 EnableSwitch 同样如此）。
  const locked = bundle?.readOnlyReason !== undefined || (bundle?.error !== undefined && state !== "enabled");
  // 图标优先用本机已安装插件的 manifest 图标（宿主读出来的 data:URL），
  // 其次用市场条目里的图标，都没有就用宿主的默认插件图形。
  const iconSource = bundle?.meta?.icon || entry.icon;
  const artwork = iconSource
    ? jsx("img", { className: "nmk-packageImage", src: iconSource, alt: "", width: 48, height: 48 })
    : jsx(P.PluginArtworkDefault, { size: 48 });
  const titleRow = jsxs("div", { className: "nmk-titleRow", children: [
    installed
      ? jsx("button", { type: "button", className: "nmk-cardOpen nmk-cardTitle", onClick: onOpen, children: title })
      : jsx("span", { className: "nmk-cardTitle", children: title }),
    version ? jsx("span", { className: "nmk-versionTag", children: version.version }) : null,
    jsx(P.Tag, {
      tone: tagTone(state),
      className: "nmk-statusTag",
      children: t(state === "enabled" ? "stateEnabled" : state === "installed-off" ? "stateInstalledOff" : state === "provided" ? "stateProvided" : "stateNotInstalled"),
    }),
  ] });
  const main = jsx("div", { className: "nmk-cardMain", children: [
    titleRow,
    jsx("p", { className: "nmk-cardDesc", children: descriptionOf(entry) }),
  ] });
  const end = state === "not-installed"
    ? jsx(P.Button, { variant: "primary", size: "sm", disabled: working, onClick: onInstall, children: t("install") })
    : state === "provided"
      ? null
      : jsx(P.Switch, {
          checked: state === "enabled",
          label: t("switchAria", { name: title }),
          disabled: working || locked,
          ...(bundle?.readOnlyReason === undefined ? {} : { title: String(bundle.readOnlyReason) }),
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
    "data-plugin-status": state,
    children: head,
  });
}

class TabBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return h("div", { className: "nmk-notice", children: String((this.state.error && this.state.error.message) || this.state.error) });
    return this.props.children;
  }
}

function NanoMarketTab(props) {
  const t = props.t;
  // 首屏用快照：零网络，卡片立刻出现。
  const [entries, setEntries] = useState(() => normalizeEntries(SNAPSHOT.entries));
  const [bundles, setBundles] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  // 状态提示是瞬时的：过几秒自己消失，不长期占着版面。
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(""), 2600);
    return () => clearTimeout(timer);
  }, [message]);
  const [notice, setNotice] = useState("");
  const liveRef = useRef(false);

  const reload = useCallback(async () => {
    setNotice("");
    // 1) 本机已安装清单（本地 IPC，毫秒级）
    try {
      const answer = await props.ctx.remote.pluginManager.listBundles();
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "listBundles failed");
      const byName = {};
      for (const bundle of answer.value || []) byName[bundle.name] = bundle;
      setBundles(byName);
    } catch (error) {
      setNotice(error?.message || String(error));
    }
    // 2) 市场索引（网络）：后台刷新，拿到宿主算好的安装规格与版本
    try {
      const answer = await props.ctx.remote.pluginMarket.search(MARKET_INDEX, { sort: { kind: "index" }, offset: 0, limit: 100 });
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "market search failed");
      const fresh = normalizeEntries(answer.value?.entries || []);
      if (fresh.length) {
        liveRef.current = true;
        setEntries(fresh);
      }
      return fresh;
    } catch (error) {
      // 没有网络也不影响浏览：快照已经画在屏幕上了。
      setNotice(error?.message || String(error));
      return null;
    }
  }, [props.ctx]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(name, task, failKey) {
    setBusy(name);
    setMessage("");
    try {
      const result = await task();
      const outcome = result?.value?.application;
      if (outcome === "failed") {
        const code = result.value.error?.code;
        setMessage(t(failKey) + "：" + t(errorKey(code)));
        return;
      }
      if (outcome === "restart-required") setMessage(t("restartRequired"));
      else setMessage(t("done"));
    } catch (error) {
      setMessage(t(failKey) + "：" + (error?.message || t("errorUnknown")));
    } finally {
      setBusy("");
      await reload();
    }
  }

  const toggle = (entry, next) => {
    void run(entry.name, () => props.ctx.remote.pluginManager.setBundleEnabled(entry.name, next), next ? "enableFailed" : "disableFailed");
  };

  const install = async (entry) => {
    // 安装前刷新一次：规格与兼容性都取宿主算好的那份。
    const fresh = liveRef.current ? null : await reload();
    const target = fresh?.find((item) => item.name === entry.name) || entry;
    const version = target.versions?.find((item) => item.version === target.defaultVersion) || target.versions?.[0];
    if (!version?.install) {
      setMessage(t("installUnavailable"));
      return;
    }
    if (!confirm(t("confirmInstall", { name: titleOf(target), version: version.version }))) {
      setMessage(t("cancelled"));
      return;
    }
    props.install({ ...version.install, title: titleOf(target), version: version.version });
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
            busy,
            key: entry.name,
            onToggle: (next) => toggle(entry, next),
            onInstall: () => void install(entry),
            onOpen: () => props.openPackage(entry.name),
          })) }),
    ] }),
    notice ? jsx("div", { className: "nmk-notice", children: notice }) : null,
    message ? jsx("div", { className: "nmk-msg" + (message.includes("失败") ? " err" : ""), children: message }) : null,
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
    // 页签的宿主 props 只有 install / openPackage；翻译函数与 ctx 由我们显式带进去。
    return h(TabBoundary, { children: h(NanoMarketTab, { ...props, t, ctx }) });
  }));
}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
