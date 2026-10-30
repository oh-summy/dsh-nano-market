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
//   已安装未启用  → 启用 / 卸载
//   已启用        → 配置 / 停用 / 卸载
// 二级页面：点「配置」交给宿主（openPackage）打开官方插件详情页——
//   那里由宿主渲染 plugins.bundle.config 配置表单与各插件自己的 detail 区段。
//
// 宿主提供的 ownerProps（见 client-ui-plugin-manager 的 PluginTabProps）：
//   install(target)    安装一个确切版本（自带确认弹窗与安装流程）
//   openPackage(name)  切到「已安装」页并打开该包的详情页
const { createElement: h, useState, useEffect, useCallback, Fragment } = React;

const NS = "nanoMarket";

// 本市场自己的索引。市场条目由 catalog/entries.jsonl 生成，install spec 已由宿主算好。
const MARKET_INDEX = "https://oh-summy.github.io/dsh-nano-market/index.json";

const zh = {
  title: "Nano Market",
  subtitle: "本市场注册的插件——安装、启用、卸载都在这里。",
  loading: "正在读取市场索引…",
  failed: "读取市场索引失败",
  retry: "重试",
  install: "安装",
  configure: "配置",
  enable: "启用",
  disable: "停用",
  uninstall: "卸载",
  stateNotInstalled: "未安装",
  stateInstalledOff: "已安装 · 未启用",
  stateEnabled: "已启用",
  stateProvided: "宿主内置",
  stateUpdate: "可更新",
  empty: "这个市场还没有注册任何插件。",
  incompatible: "与当前 DSH 版本不兼容",
  busy: "处理中…",
  confirmUninstall: "卸载 {name}？该插件提供的功能会随之消失。",
  uninstallFailed: "卸载失败",
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
.nmk-top{display:flex;align-items:flex-start;gap:13px}
.nmk-icon{width:40px;height:40px;border-radius:11px;flex-shrink:0;background:linear-gradient(135deg,#eef3ff,#f7f9ff);border:1px solid #e6ebf5;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600;color:#3370ff;overflow:hidden}
.nmk-icon img{width:100%;height:100%;object-fit:cover}
.nmk-main{min-width:0;flex:1}
.nmk-name{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:9px;flex-wrap:wrap;line-height:1.4}
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

function NanoMarketTab(props) {
  const t = props.t;
  const [listing, setListing] = useState({ status: "loading", entries: [], error: "" });
  const [bundles, setBundles] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    setListing((s) => ({ ...s, status: "loading", error: "" }));
    try {
      const [answer, bundleAnswer] = await Promise.all([
        props.ctx.remote.pluginMarket.search(MARKET_INDEX, { sort: { kind: "index" }, offset: 0, limit: 100 }),
        props.ctx.remote.pluginManager.listBundles(),
      ]);
      if (!answer || answer.ok === false) throw new Error(answer?.error?.message || "market search failed");
      // 宿主的 remote 调用统一返回 { ok, value | error }。
      if (!bundleAnswer || bundleAnswer.ok === false) throw new Error(bundleAnswer?.error?.message || "listBundles failed");
      const byName = {};
      for (const bundle of bundleAnswer.value || []) byName[bundle.name] = bundle;
      setBundles(byName);
      setListing({ status: "ready", entries: answer.value?.entries || [], error: "" });
    } catch (error) {
      setListing({ status: "failed", entries: [], error: error?.message || String(error) });
    }
  }, [props.ctx]);

  useEffect(() => { void reload(); }, [reload]);

  async function run(name, task) {
    setBusy(name);
    setMessage("");
    try {
      const result = await task();
      if (result && result.ok === false) throw new Error(result.error?.message || "操作失败");
      await reload();
    } catch (error) {
      setMessage(t("uninstallFailed") + "：" + (error?.message || error));
    } finally {
      setBusy("");
    }
  }

  function install(entry) {
    const version = defaultVersionOf(entry);
    if (!version) return;
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
                const compatible = compatibleOf(version);
                const working = busy === entry.name;
                const badge = state === "enabled"
                  ? { cls: "on", text: t("stateEnabled") }
                  : state === "installed-off"
                    ? { cls: "warn", text: t("stateInstalledOff") }
                    : { cls: "off", text: t("stateNotInstalled") };
                return h("div", { className: "nmk-card", key: entry.name },
                  h("div", { className: "nmk-top" },
                    h("div", { className: "nmk-icon" }, entry.icon
                      ? h("img", { src: entry.icon, alt: "" })
                      : h("span", null, titleOf(entry).slice(0, 1))),
                    h("div", { className: "nmk-main" },
                      h("div", { className: "nmk-name" },
                        h("span", null, titleOf(entry)),
                        version ? h("span", { className: "nmk-ver" }, version.version) : null,
                        h("span", { className: "nmk-badge " + badge.cls }, badge.text),
                        compatible ? null : h("span", { className: "nmk-badge off" }, t("incompatible")),
                      ),
                      h("p", { className: "nmk-desc" }, descriptionOf(entry)),
                    ),
                  ),
                  h("div", { className: "nmk-actions" },
                    state === "not-installed"
                      ? h("button", { type: "button", className: "nmk-btn primary", disabled: working || !compatible, onClick: () => install(entry) }, t("install"))
                      : null,
                    state === "installed-off"
                      ? h("button", { type: "button", className: "nmk-btn primary", disabled: working, onClick: () => void run(entry.name, () => props.ctx.remote.pluginManager.setBundleEnabled(entry.name, true)) }, t("enable"))
                      : null,
                    state === "enabled"
                      ? h("button", { type: "button", className: "nmk-btn primary", disabled: working, onClick: () => props.openPackage(entry.name) }, t("configure"))
                      : null,
                    state === "enabled"
                      ? h("button", { type: "button", className: "nmk-btn", disabled: working, onClick: () => void run(entry.name, () => props.ctx.remote.pluginManager.setBundleEnabled(entry.name, false)) }, t("disable"))
                      : null,
                    state !== "not-installed" ? h("span", { className: "nmk-spacer" }) : null,
                    state !== "not-installed"
                      ? h("button", { type: "button", className: "nmk-btn danger", disabled: working, onClick: () => {
                          if (!confirm(t("confirmUninstall", { name: titleOf(entry) }))) return;
                          void run(entry.name, () => props.ctx.remote.pluginManager.removeBundle(entry.name));
                        } }, t("uninstall"))
                      : null,
                  ),
                  busy === entry.name ? h("div", { className: "nmk-msg" }, t("busy")) : null,
                );
              })),
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
