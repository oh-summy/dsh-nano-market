// Nano Market 标签页的纯逻辑（无 React / 无宿主依赖）——
// 单独成文件让测试可以 import 后行为级验证（归一化 → 更新目标选择 → 更新载荷），
// 构建时 build-client.mjs 会剥掉 export 关键字、拼接进客户端包体（client.js 在工厂作用域内直接可见）。

// 快照与宿主搜索结果归一成同一形状：名字、描述、图标、版本与安装规格。
// versions[].compatibility 必须保留——宿主用它说明该版本与运行中的 DSH 是否兼容。
// versions[].update 必须保留——宿主对已安装插件算好的更新资格（布尔）：
//   只有「同仓库同目录、目标版本更高、bundle.update === git」的版本才会是 true；
//   「更新」按钮的资格判定完全以它为准，npm 源与跨仓库版本天然不会出现。
export function normalizeEntry(raw) {
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

export function normalizeEntries(raws) {
  return (raws || []).map(normalizeEntry);
}

// 官方 Discover 的 installable() 同规则：兼容，或该精确组合已被豁免。
// 快照路径没有 compatibility 字段（构建期无法判定），交给宿主安装弹窗把关。
export function installable(compatibility) {
  return compatibility === undefined || compatibility.compatible === true || compatibility.exempted === true;
}

export function presentedVersion(entry) {
  return entry.versions?.find((item) => item.version === entry.defaultVersion) || entry.versions?.[0];
}

export function prerelease(version) {
  return version.split("+")[0]?.includes("-") === true;
}

// 官方 plugin-market 的 updateTarget 同规则：对外展示的版本优先，
// 它不可更新（或未装本机清单没得比）时找第一个非预发布的可更新版本。
export function updateTarget(entry) {
  const updatable = (version) => version.update && installable(version.compatibility);
  const presented = presentedVersion(entry);
  return updatable(presented) ? presented : entry.versions?.find((version) => updatable(version) && !prerelease(version.version));
}

// 「更新」按钮的载荷 = PluginTabUpdate（slot 契约）：
//   spec 用目标版本的 install.spec（官方 DiscoverSection 同一取法），
//   update 只是宿主算好的资格布尔，不带 spec。
// 无合格目标 / 无 install 规格 / 非本市场更新的形态 → null（调用方不渲染按钮）。
export function updatePayloadOf(entry) {
  const target = updateTarget(entry);
  if (!target?.update || !target.install?.spec) return null;
  return { packageName: entry.name, version: target.version, spec: target.install.spec };
}
