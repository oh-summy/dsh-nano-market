// 生成本市场快照：把已发布的 dist/index.json 变成页签能直接吃的一小块数据。
//
// 为什么要它：页签首屏不该等网络。市场条目在发布时才变（一天最多一次），
// 而 GitHub Pages 的往返有几百毫秒——每次新开页面都要等，就是「点开卡一下」。
// 快照把首屏变成零网络；真正安装仍然用宿主搜索到的规格（见 client.js）。
//
// 目录是仓库根的 dist/index.json（根构建产出，CI 里先生成后构建插件）。
//
// 确定性：快照里不放任何时间戳。根索引每次构建都会写新的 generatedAt，
// 带着它就意味着每次 CI 都会写出与仓库里不同的 lib/，插件守卫必红、
// Pages 永远发不出去。快照的内容只由市场内容决定。
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { installTarget } from "./install-target.mjs";

const indexUrl = new URL("../../../dist/index.json", import.meta.url);
if (!existsSync(indexUrl)) {
  throw new Error(
    "gen-snapshot: 找不到 dist/index.json —— 先在仓库根运行 `npm run build`（它生成本市场发布的索引），再构建插件。",
  );
}
const index = JSON.parse(readFileSync(indexUrl, "utf8"));

// 宿主的 defaultVersion 规则：最高且非预发布。快照按同样的规则挑，
// 否则离线首屏那条路径可能指向一个预发布版本。
function defaultVersionOf(versions) {
  const stable = versions.filter((item) => !/-/.test(item.version));
  return (stable[0] ?? versions[0])?.version;
}
const entries = (index.plugins || []).map((plugin) => ({
  name: plugin.name,
  title: plugin.title,
  description: plugin.description,
  icon: plugin.icon,
  // 官方索引的版本按 semver 降序（最新在前），所以第一个就是可装的最新版。
  // 宿主刷新成功后会换成它算好的「最高兼容版本」。
  versions: (plugin.versions || []).map((version) => ({
    version: version.version,
    engines: version.engines,
    install: installTarget(plugin.name, version),
  })),
  defaultVersion: defaultVersionOf(plugin.versions || []),
}));
const snapshot = { entries };
writeFileSync(new URL("../src/market-snapshot.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
console.log(`market snapshot written: ${entries.length} plugin(s)`);
