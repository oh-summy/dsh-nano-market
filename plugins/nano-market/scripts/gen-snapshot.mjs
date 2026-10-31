// 生成本市场快照：把已发布的 dist/index.json 变成页签能直接吃的一小块数据。
//
// 为什么要它：页签首屏不该等网络。市场条目在发布时��变（一天最多一次），
// 而 GitHub Pages 的往返有几百毫秒——每次新开页面都要等，就是「点开卡一下」。
// 快照把首屏变成零网络；真正安装仍然用宿主搜索到的规格（见 client.js）。
//
// 目录是仓库根的 dist/index.json（根构建产出，CI 里先生成后构建插件），
// 规格换算与官方 marketInstallTarget 一致（测试会拿官方包逐条比对）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** 与 @deepseek-ai/dsh-plugin-market-index 的 marketInstallTarget 同规则。 */
export function installTarget(name, version) {
  const from = version.source || {};
  if (from.type === "npm") {
    return { spec: `${name}@${version.version}`, ...(from.registry === undefined ? {} : { registry: from.registry }) };
  }
  const url = from.url.endsWith(".git") ? from.url : `${from.url}.git`;
  return { spec: `git+${url}#${from.commit}${from.path === undefined ? "" : `&path:/${from.path}`}` };
}

const indexUrl = new URL("../../../dist/index.json", import.meta.url);
if (!existsSync(indexUrl)) {
  throw new Error(
    "gen-snapshot: 找不到 dist/index.json —— 先在仓库根运行 `npm run build`（它生成本市场发布的索引），再构建插件。",
  );
}
const index = JSON.parse(readFileSync(indexUrl, "utf8"));
const entries = (index.plugins || []).map((plugin) => ({
  name: plugin.name,
  title: plugin.title,
  description: plugin.description,
  icon: plugin.icon,
  author: plugin.author,
  homepage: plugin.homepage,
  repository: plugin.repository,
  metadata: plugin.metadata,
  versions: (plugin.versions || []).map((version) => ({
    version: version.version,
    publishTimestamp: version.publishTimestamp,
    engines: version.engines,
    install: installTarget(plugin.name, version),
  })),
}));
const snapshot = { generatedAt: index.generatedAt, title: index.title, entries };
writeFileSync(new URL("../src/market-snapshot.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
console.log(`market snapshot written: ${entries.length} plugin(s)`);
