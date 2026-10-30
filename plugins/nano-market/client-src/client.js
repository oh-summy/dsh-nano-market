// Nano Market — Plugins 页的专属页签（plugins.tab，与官方 Discover 同机制）。
// 一级页面：列出本市场注册的插件，可安装 / 启用 / 停用 / 卸载。
// 二级页面：点「配置」交给宿主（openPackage）打开官方插件详情页——
//   那里由宿主渲染 plugins.bundle.config 配置表单与各插件自己的 detail 区段。
//
// 宿主提供的 ownerProps（见 client-ui-plugin-manager 的 PluginTabProps）：
//   install(target)    安装一个确切版本（自带确认弹窗与安装流程）
//   openPackage(name)  切到「已安装」页并打开该包的详情页
const { createElement: h, useState, useEffect, useCallback, Fragment } = React;

const NS = "nanoMarket";
const PACKAGE = "@oh-summy/nano-market";

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
  installed: "已安装",
  notInstalled: "未安装",
  updateAvailable: "可更新",
  differentVersion: "已装其他版本",
  provided: "宿主内置",
  empty: "这个市场还没有注册任何插件。",
  source: "市场索引",
  incompatible: "与当前 DSH 版本不兼容",
  busy: "处理中…",
};
const en = { ...zh };

const CSS = `
.nmk-wrap{max-width:820px;margin:0 auto;padding:4px 0 20px;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.nmk-head{margin:0 0 18px}
.nmk-head h4{margin:0 0 6px;font-size:19px;font-weight:650;letter-spacing:-.01em}
.nmk-head p{margin:0;font-size:13px;color:#8b949e;line-height:1.6}
.nmk-list{display:flex;flex-direction:column;gap:12px}
.nmk-card{border:1px solid #eef0f3;border-radius:14px;background:#fff;padding:16px 18px}
.nmk-row{display:flex;align-items:flex-start;gap:12px}
.nmk-icon{width:38px;height:38px;border-radius:10px;flex-shrink:0;background:#f2f4f7;display:flex;align-items:center;justify-content:center;font-size:16px;overflow:hidden}
.nmk-icon img{width:100%;height:100%;object-fit:cover}
.nmk-main{min-width:0;flex:1}
.nmk-name{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nmk-ver{font-size:12px;color:#9ca3af;font-family:ui-monospace,monospace}
.nmk-desc{margin:6px 0 0;font-size:12.5px;color:#6b7280;line-height:1.65}
.nmk-badge{font-size:11px;border-radius:999px;padding:2px 9px;font-weight:600}
.nmk-badge.on{background:#ecfdf3;color:#15803d}
.nmk-badge.off{background:#f3f4f6;color:#6b7280}
.nmk-badge.upd{background:#fff7ed;color:#c2410c}
.nmk-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}
.nmk-btn{border:1px solid #d8dde5;background:#fff;border-radius:8px;padding:6px 13px;font:inherit;font-size:12.5px;cursor:pointer;color:#374151}
.nmk-btn:hover:not(:disabled){border-color:#bfd0f5;background:#f7faff}
.nmk-btn:disabled{opacity:.5;cursor:default}
.nmk-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.nmk-btn.danger{color:#dc2626;border-color:#f3d4d4}
.nmk-msg{font-size:12.5px;color:#2563eb;margin-top:10px;min-height:18px}
.nmk-msg.err{color:#dc2626}
.nmk-empty{text-align:center;color:#9ca3af;font-size:13px;padding:40px 0;border:1px dashed #e5e7eb;border-radius:14px}
.nmk-skel{height:74px;border-radius:14px;background:linear-gradient(90deg,#f1f3f5 25%,#e9ecef 50%,#f1f3f5 75%);background-size:200% 100%;animation:nmk 1.1s infinite linear}
@keyframes nmk{0%{background-position:200% 0}100%{background-position:-200% 0}}
`;

function statusOf(entry) {
  const st = entry?.installation?.status || "not-installed";
  if (st === "installed") return { id: "installed", text: zh.installed };
  if (st === "update-available") return { id: "update", text: zh.updateAvailable };
  if (st === "different-version") return { id: "other", text: zh.differentVersion };
  if (st === "provided") return { id: "off", text: zh.provided };
  return { id: "off", text: zh.notInstalled };
}

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
  if (!version) return false;
  return version?.compatibility?.compatible !== false;
}

function NanoMarketTab(props) {
  const t = props.t;
  const [state, setState] = useState({ status: "loading", entries: [], error: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: "" }));
    try {
      // query 的宿主契约要求 sort/offset/limit 三个必填字段；index 排序保留 catalog 的策展顺序。
      const answer = await props.ctx.remote.pluginMarket.search(MARKET_INDEX, {
        sort: { kind: "index" },
        offset: 0,
        limit: 100,
      });
      if (!answer || answer.ok === false) {
        throw new Error(answer?.error?.message || "market search failed");
      }
      setState({ status: "ready", entries: answer.value?.entries || [], error: "" });
    } catch (error) {
      setState({ status: "failed", entries: [], error: error?.message || String(error) });
    }
  }, [props.ctx]);

  useEffect(() => { void reload(); }, [reload]);

  async function run(name, task, pending) {
    setBusy(name);
    setMessage(pending);
    try {
      const result = await task();
      if (result && result.ok === false) throw new Error(result.error?.message || "操作失败");
      setMessage("");
      await reload();
    } catch (error) {
      setMessage("失败：" + (error?.message || error));
    } finally {
      setBusy("");
    }
  }

  function install(entry) {
    const version = defaultVersionOf(entry);
    if (!version) return;
    props.install({
      ...(version.install || {}),
      title: titleOf(entry),
      version: version.version,
    });
  }

  const entries = state.entries;
  return h(Fragment, null,
    h("style", null, CSS),
    h("div", { className: "nmk-wrap" },
      h("div", { className: "nmk-head" },
        h("h4", null, t("title")),
        h("p", null, t("subtitle")),
      ),
      state.status === "loading"
        ? h("div", { className: "nmk-list" }, h("div", { className: "nmk-skel" }), h("div", { className: "nmk-skel" }))
        : state.status === "failed"
          ? h("div", { className: "nmk-card" },
              h("div", { className: "nmk-desc" }, t("failed") + "：" + state.error),
              h("div", { className: "nmk-actions" },
                h("button", { type: "button", className: "nmk-btn", onClick: () => void reload() }, t("retry")),
              ),
            )
          : entries.length === 0
            ? h("div", { className: "nmk-empty" }, t("empty"))
            : h("div", { className: "nmk-list" }, entries.map((entry) => {
                const version = defaultVersionOf(entry);
                const status = statusOf(entry);
                const installed = status.id === "installed" || status.id === "update" || status.id === "other";
                const compatible = compatibleOf(version);
                const working = busy === entry.name;
                return h("div", { className: "nmk-card", key: entry.name },
                  h("div", { className: "nmk-row" },
                    h("div", { className: "nmk-icon" }, entry.icon
                      ? h("img", { src: entry.icon, alt: "" })
                      : h("span", null, titleOf(entry).slice(0, 1))),
                    h("div", { className: "nmk-main" },
                      h("div", { className: "nmk-name" },
                        h("span", null, titleOf(entry)),
                        version ? h("span", { className: "nmk-ver" }, version.version) : null,
                        h("span", { className: "nmk-badge " + (status.id === "installed" ? "on" : status.id === "update" ? "upd" : "off") }, status.text),
                        compatible ? null : h("span", { className: "nmk-badge off" }, t("incompatible")),
                      ),
                      h("p", { className: "nmk-desc" }, descriptionOf(entry)),
                    ),
                  ),
                  h("div", { className: "nmk-actions" },
                    installed
                      ? h("button", { type: "button", className: "nmk-btn primary", disabled: working, onClick: () => props.openPackage(entry.name) }, t("configure"))
                      : h("button", { type: "button", className: "nmk-btn primary", disabled: working || !compatible, onClick: () => install(entry) }, t("install")),
                    installed
                      ? h("button", { type: "button", className: "nmk-btn", disabled: working, onClick: () => void run(entry.name, () => props.ctx.remote.pluginManager.setBundleEnabled(entry.name, false), t("busy")) }, t("disable"))
                      : null,
                    installed
                      ? h("button", { type: "button", className: "nmk-btn danger", disabled: working, onClick: () => {
                          if (!confirm("卸载 " + titleOf(entry) + "？该插件提供的功能会随之消失。")) return;
                          void run(entry.name, () => props.ctx.remote.pluginManager.removeBundle(entry.name), t("busy"));
                        } }, t("uninstall"))
                      : null,
                  ),
                  message && busy === entry.name ? h("div", { className: "nmk-msg" }, message) : null,
                );
              })),
      message && !busy ? h("div", { className: "nmk-msg" + (message.startsWith("失败") ? " err" : "") }, message) : null,
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
