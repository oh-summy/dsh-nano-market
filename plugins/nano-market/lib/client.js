window.__ModuleLoader__.load({
	id: "@oh-summy/nano-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		// Nano Market — Plugins 页的专属页签（plugins.tab，与官方 Discover 同机制）。
// 一级页面：列出本市场注册的插件，按「未安装 → 已安装未启用 → 已启用」三态给出对应操作：
//   未安装        → 安装
//   已安装未启用  → 启用
//   已启用        → 停用（点整张卡片进入插件页面）
// 二级页面：整卡点击交给宿主（openPackage）打开官方插件详情页——
//   那里由宿主渲染 plugins.bundle.config 配置表单与各插件自己的 detail 区段。
// 卸载不在这里做：官方插件页用同样的方式管理启停与卸载，重复一份只会让人多点一次。
//
// 宿主提供的 ownerProps（见 client-ui-plugin-manager 的 PluginTabProps）：
//   install(target)    安装一个确切版本（自带确认弹窗与安装流程）
//   openPackage(name)  切到「已安装」页并打开该包的详情页
const { createElement: h, useState, useEffect, useCallback, Fragment } = React;

const NS = "nanoMarket";

// 本市场自己的索引。市场条目由 catalog/entries.jsonl 生成，install spec 已由宿主算好。
const MARKET_INDEX = "https://oh-summy.github.io/dsh-nano-market/index.json";

// 市场索引只在重新发布时变化，页签切换不该每次都等它：
// 模块级缓存 5 分钟，之后静默刷新。安装状态始终即时读取。
let marketCache = null;
let marketFetchedAt = 0;
const MARKET_CACHE_MS = 5 * 60 * 1000;
const CACHE_KEY = "dsh.nano-market.entries";

// The tab is slow when it waits on the network for the index. The index only
// changes when the market is republished, so keep the last list in
// sessionStorage and paint it immediately; refresh behind it.
function readStoredCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed : null;
  } catch { return null; }
}

function writeStoredCache(entries) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ entries, at: Date.now() })); } catch { /* private mode */ }
}


const zh = {
  title: "Nano Market",
  subtitle: "本市场注册的插件——安装、启用都在这里，点开卡片进配置。",
  loading: "正在读取市场索引…",
  failed: "读取市场索引失败",
  retry: "重试",
  install: "安装",
  configure: "配置",
  enable: "启用",
  disable: "停用",
  uninstall: "卸载",
  openHint: "点击卡片进入配置",
  switchAria: "{name} 的启用状态",
  switchOn: "已启用",
  switchOff: "已停用",
  installedHint: "安装后即可在这里管理",
  stateNotInstalled: "未安装",
  stateInstalledOff: "已安装 · 未启用",
  stateEnabled: "已启用",
  stateProvided: "宿主内置",
  stateUpdate: "可更新",
  empty: "这个市场还没有注册任何插件。",
  incompatible: "与当前 DSH 版本不兼容",
  busy: "处理中…",
  confirmUninstall: "卸载 {name}？该插件提供的功能会随之消失。",
  confirmInstall: "安装 {name} {version}？插件代码会在本机运行。",
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
  enableFailed: "启用失败",
  disableFailed: "停用失败",
  done: "完成",
};
const en = { ...zh };

const CSS = `
.nmk-wrap{max-width:840px;margin:0 auto;padding:2px 0 28px;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.nmk-head{margin:0 0 20px}
.nmk-head h4{margin:0 0 6px;font-size:20px;font-weight:650;letter-spacing:-.015em}
.nmk-head p{margin:0;font-size:13px;color:#8b949e;line-height:1.6}
.nmk-list{display:flex;flex-direction:column;gap:12px}
.nmk-card{border:1px solid #e9ecf1;border-radius:14px;background:#fff;padding:16px 18px;transition:border-color .15s,box-shadow .15s}
.nmk-card:hover{border-color:#d8e0ee;box-shadow:0 1px 3px rgba(31,35,41,.05)}
.nmk-card.nmk-open{cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s}
.nmk-card.nmk-open:hover{border-color:#b9cdf5;box-shadow:0 4px 14px rgba(31,35,41,.08);transform:translateY(-1px)}
.nmk-card.nmk-open:focus-visible{outline:2px solid #3370ff;outline-offset:2px}
.nmk-card.nmk-open:active{transform:translateY(0)}
.nmk-top{display:flex;align-items:flex-start;gap:13px}
.nmk-icon{width:42px;height:42px;border-radius:12px;flex-shrink:0;background:linear-gradient(135deg,#eef3ff,#f7f9ff);border:1px solid #e6ebf5;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600;color:#3370ff;overflow:hidden}
.nmk-icon img{width:100%;height:100%;object-fit:cover;display:block}
.nmk-hint{font-size:11.5px;color:#9aa3af;margin-left:2px}
.nmk-switch{position:relative;flex:0 0 auto;width:38px;height:22px;border-radius:999px;background:#d8dde6;border:0;padding:0;cursor:pointer;transition:background .15s}
.nmk-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.25);transition:transform .15s}
.nmk-switch[aria-checked="true"]{background:#3370ff}
.nmk-switch[aria-checked="true"]::after{transform:translateX(16px)}
.nmk-switch:disabled{opacity:.5;cursor:not-allowed}
.nmk-switch:focus-visible{outline:2px solid #3370ff;outline-offset:2px}
.nmk-main{min-width:0;flex:1}
.nmk-name{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:9px;flex-wrap:wrap;line-height:1.4}
.nmk-title{border:0;background:transparent;padding:0;font:inherit;font-size:inherit;font-weight:inherit;color:inherit;cursor:pointer;text-align:left;border-radius:5px}
.nmk-title:hover{color:var(--cl-blue,#3370ff);text-decoration:underline;text-underline-offset:3px}
.nmk-title:focus-visible{outline:2px solid #3370ff;outline-offset:2px}
.nmk-ver{font-size:12px;color:#9aa3af;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500}
.nmk-desc{margin:7px 0 0;font-size:12.5px;color:#6b7280;line-height:1.7}
.nmk-badge{font-size:11px;border-radius:999px;padding:2px 9px;font-weight:600;white-space:nowrap;line-height:1.6}
.nmk-badge.on{background:#eaf7ef;color:#15803d}
.nmk-badge.off{background:#f3f4f6;color:#8a929e}
.nmk-badge.warn{background:#fff5e8;color:#b45309}
.nmk-actions{display:flex;gap:9px;margin-top:15px;align-items:center;flex-wrap:wrap}
.nmk-spacer{flex:1}
.nmk-btn{border:1px solid #dde1e8;background:#fff;border-radius:8px;padding:6px 14px;font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;color:#414957;transition:background .12s,border-color .12s,color .12s;line-height:1.6}
.nmk-btn:hover:not(:disabled){background:#f5f7fa;border-color:#c9d2e0;color:#1f2937}
.nmk-btn:active:not(:disabled){background:#eef1f6}
.nmk-btn:disabled{opacity:.45;cursor:not-allowed}
.nmk-btn.primary{background:#3370ff;border-color:#3370ff;color:#fff}
.nmk-btn.primary:hover:not(:disabled){background:#2860e6;border-color:#2860e6;color:#fff}
.nmk-btn.primary:active:not(:disabled){background:#1f52cc}
.nmk-btn.danger{color:#c2413b;border-color:#f0d8d6;background:#fff}
.nmk-btn.danger:hover:not(:disabled){background:#fdf3f2;border-color:#e5b7b3;color:#a3342e}
.nmk-msg{font-size:12.5px;color:#3370ff;margin-top:11px;min-height:17px;line-height:1.5}
.nmk-notice{margin:0 0 14px;padding:9px 12px;border-radius:10px;background:#fff8e8;border:1px solid #f0e2c0;color:#8a5a00;font-size:12.5px;line-height:1.6}
.nmk-msg.err{color:#c2413b}
.nmk-empty{text-align:center;color:#9aa3af;font-size:13px;padding:44px 20px;border:1px dashed #e3e7ee;border-radius:14px;background:#fcfdfe}
.nmk-skel{height:92px;border-radius:14px;background:linear-gradient(90deg,#f2f4f7 25%,#e9ecef 50%,#f2f4f7 75%);background-size:200% 100%;animation:nmk 1.15s infinite linear}
@keyframes nmk{0%{background-position:200% 0}100%{background-position:-200% 0}}
`;

function titleOf(entry) {
  const t = entry?.title;
  if (typeof t === "string") return t;
  return t?.zh || t?.en || entry?.name || "";
}

function descriptionOf(entry) {
  const d = entry?.description;
  if (typeof d === "string") return d;
  return d?.zh || d?.en || "";
}

function defaultVersionOf(entry) {
  const wanted = entry?.defaultVersion;
  const versions = entry?.versions || [];
  return versions.find((v) => v.version === wanted) || versions[0];
}

function compatibleOf(version) {
  return Boolean(version) && version?.compatibility?.compatible !== false;
}

/** 三态：未安装 / 已安装未启用 / 已启用。enabled 与 installed 来自宿主 pluginManager。 */
function stateOf(entry, bundle) {
  const installed = Boolean(bundle?.installed);
  const enabled = Boolean(bundle?.enabled);
  if (!installed) return "not-installed";
  return enabled ? "enabled" : "installed-off";
}

/** Map a host management error code to something the person can act on. */
function errorKey(code) {
  if (code === "not-removable") return "errorNotRemovable";
  if (code === "stop-profile") return "errorStopProfile";
  if (code === "bundle-in-use") return "errorBundleInUse";
  return "errorUnknown";
}

function NanoMarketTab(props) {
  const t = props.t;
  const [listing, setListing] = useState({ status: "loading", entries: [], error: "" });
  const [bundles, setBundles] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    setNotice("");
    // 1) Paint the last known list right away; the network can follow.
    const stored = readStoredCache();
    if (stored && marketCache === null) {
      marketCache = stored.entries;
      marketFetchedAt = stored.at ?? 0;
    }
    if (marketCache !== null) setListing({ status: "ready", entries: marketCache, error: "" });
    else setListing((s) => ({ ...s, status: "loading", error: "" }));

    // 2) Is this market even indexed here? Without it the host cannot search,
    //    so say so instead of showing a list that cannot be installed from.
    let indexed = false;
    try {
      const indexAnswer = await props.ctx.remote.pluginMarket.listIndexes();
      if (!indexAnswer || indexAnswer.ok === false) throw new Error(indexAnswer?.error?.message || "listIndexes failed");
      indexed = (indexAnswer.value ?? []).some((item) => item?.url === MARKET_INDEX);
      if (!indexed) setNotice(t("indexMissing", { url: MARKET_INDEX }));
    } catch (error) {
      setNotice(error?.message || String(error));
    }

    // 3) Installation state is local and always current.
    try {
      const bundleAnswer = await props.ctx.remote.pluginManager.listBundles();
      if (!bundleAnswer || bundleAnswer.ok === false) throw new Error(bundleAnswer?.error?.message || "listBundles failed");
      const byName = {};
      for (const bundle of bundleAnswer.value || []) byName[bundle.name] = bundle;
      setBundles(byName);
    } catch (error) {
      // A broken profile inventory must not wipe the market list.
      setNotice(error?.message || String(error));
    }

    // 4) Refresh the market when it is indexed; keep the cached list otherwise.
    if (indexed) {
      try {
        const answer = await props.ctx.remote.pluginMarket.search(MARKET_INDEX, { sort: { kind: "index" }, offset: 0, limit: 100 });
        if (answer && answer.ok) {
          marketCache = answer.value?.entries ?? marketCache;
          marketFetchedAt = Date.now();
          writeStoredCache(marketCache);
          setListing({ status: "ready", entries: marketCache, error: "" });
          return;
        }
      } catch {
        // The cached list stays on screen; a refresh failure is not an error.
      }
    }
    if (marketCache === null) setListing({ status: "failed", entries: [], error: t("failed") });
  }, [props.ctx]);
  useEffect(() => { void reload(); }, [reload]);

  async function run(name, task, failKey) {
    setBusy(name);
    setMessage("");
    try {
      const result = await task();
      if (result && result.ok === false) throw new Error(result.error?.message || t(failKey));
      // The host folds business failures into ok:true and reports the outcome in
      // application, so a failed change must not read as success.
      const outcome = result?.value?.application;
      if (outcome === "failed") {
        const code = result.value.error?.code;
        setMessage(t(failKey) + "：" + t(errorKey(code)));
        await reload();
        return;
      }
      if (outcome === "cancelled") {
        setMessage(t("cancelled"));
        return;
      }
      if (outcome === "restart-required") {
        setMessage(t("restartRequired"));
      }
      await reload();
    } catch (error) {
      setMessage(t(failKey) + "：" + (error?.message || error));
    } finally {
      setBusy("");
    }
  }

  function install(entry) {
    const version = defaultVersionOf(entry);
    if (!version) return;
    // Installing runs third-party code on this machine, so confirm first.
    // The host contract expects the caller to have confirmed.
    if (!confirm(t("confirmInstall", { name: titleOf(entry), version: version.version }))) return;
    props.install({ ...(version.install || {}), title: titleOf(entry), version: version.version });
  }

  const entries = listing.entries;
  return h(Fragment, null,
    h("style", null, CSS),
    h("div", { className: "nmk-wrap" },
      h("div", { className: "nmk-head" },
        h("h4", null, t("title")),
        h("p", null, t("subtitle")),
      ),
      listing.status === "loading"
        ? h("div", { className: "nmk-list" }, h("div", { className: "nmk-skel" }), h("div", { className: "nmk-skel" }))
        : listing.status === "failed"
          ? h("div", { className: "nmk-card" },
              h("div", { className: "nmk-desc" }, t("failed") + "：" + listing.error),
              h("div", { className: "nmk-actions" },
                h("button", { type: "button", className: "nmk-btn", onClick: () => void reload() }, t("retry")),
              ),
            )
          : entries.length === 0
            ? h("div", { className: "nmk-empty" }, t("empty"))
            : h("div", { className: "nmk-list" }, entries.map((entry) => {
                const version = defaultVersionOf(entry);
                const bundle = bundles[entry.name];
                const state = stateOf(entry, bundle);
                const installation = entry.installation || {};
                // 宿主给的 installation 只有 {status, installedVersion?}；版本以本机为准。
                const shownVersion = (state === "not-installed" ? version?.version : bundle?.version || installation.installedVersion) || version?.version;
                const canUpdate = installation.status === "update-available";
                const provided = installation.status === "provided";
                const compatible = compatibleOf(version);
                const working = busy === entry.name;
                // 宿主保护或读不出的 bundle 不给开关（宿主自己的 EnableSwitch 同样如此）。
                const locked = bundle?.readOnlyReason !== undefined || (bundle?.error !== undefined && state !== "enabled");
                const badge = state === "enabled"
                  ? { cls: "on", text: t("stateEnabled") }
                  : state === "installed-off"
                    ? { cls: "warn", text: t("stateInstalledOff") }
                    : provided
                      ? { cls: "off", text: t("stateProvided") }
                      : { cls: "off", text: t("stateNotInstalled") };
                const openable = state === "enabled";
                const open = () => props.openPackage(entry.name);
                const toggle = (next) => {
                  void run(entry.name, () => props.ctx.remote.pluginManager.setBundleEnabled(entry.name, next), next ? "enableFailed" : "disableFailed");
                };
                return h("div", {
                  className: "nmk-card" + (openable ? " nmk-open" : ""),
                  key: entry.name,
                  // 整张卡片可点（鼠标）；键盘用户走标题上的真实按钮，
                  // 这样开关不会被卡片的 role=button 吞掉按键。
                  onClick: (event) => {
                    if (event.target.closest("button, a, input, [role=\"switch\"]")) return;
                    if (openable) open();
                  },
                },
                  h("div", { className: "nmk-top" },
                    h("div", { className: "nmk-icon" }, (bundle?.meta?.icon || entry.icon)
                      ? h("img", { src: bundle?.meta?.icon || entry.icon, alt: "" })
                      : h("span", null, titleOf(entry).slice(0, 1))),
                    h("div", { className: "nmk-main" },
                      h("div", { className: "nmk-name" },
                        openable
                          ? h("button", { type: "button", className: "nmk-title", onClick: (event) => { event.stopPropagation(); open(); }, children: titleOf(entry) })
                          : h("span", null, titleOf(entry)),
                        shownVersion ? h("span", { className: "nmk-ver" }, shownVersion) : null,
                        h("span", { className: "nmk-badge " + badge.cls }, badge.text),
                        canUpdate ? h("span", { className: "nmk-badge warn" }, t("stateUpdate")) : null,
                        compatible ? null : h("span", { className: "nmk-badge off" }, t("incompatible")),
                      ),
                      h("p", { className: "nmk-desc" }, descriptionOf(entry)),
                    ),
                    state !== "not-installed"
                      ? h("button", {
                          type: "button",
                          role: "switch",
                          className: "nmk-switch",
                          "aria-checked": state === "enabled",
                          "aria-label": t("switchAria", { name: titleOf(entry) }),
                          disabled: working || locked,
                          ...(bundle?.readOnlyReason === undefined ? {} : { title: String(bundle.readOnlyReason) }),
                          onClick: (event) => {
                            event.stopPropagation();
                            toggle(state !== "enabled");
                          },
                        })
                      : null,
                  ),
                  h("div", { className: "nmk-actions" },
                    state === "not-installed" && !provided
                      ? h("button", { type: "button", className: "nmk-btn primary", disabled: working || !compatible, onClick: (event) => { event.stopPropagation(); install(entry); } }, t("install"))
                      : null,
                    state === "enabled"
                      ? h("span", { className: "nmk-hint" }, t("openHint"))
                      : state === "installed-off"
                        ? h("span", { className: "nmk-hint" }, t("installedHint"))
                        : provided
                          ? h("span", { className: "nmk-hint" }, t("stateProvided"))
                          : null,
                  ),
                  busy === entry.name ? h("div", { className: "nmk-msg" }, t("busy")) : null,
                );
              })),
      notice ? h("div", { className: "nmk-notice" }, notice) : null,
      message ? h("div", { className: "nmk-msg" + (message.includes("失败") ? " err" : "") }, message) : null,
    ),
  );
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
    locale: NS,
  }, function NanoMarketTabEntry(props) {
    return h(NanoMarketTab, { ...props, t, ctx });
  }));
}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
