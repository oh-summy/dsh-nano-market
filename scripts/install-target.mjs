// 安装规格换算：与官方 @deepseek-ai/dsh-plugin-market-index 的 marketInstallTarget
// 同规则。单独成文件（无副作用），这样测试可以引入它而不触发任何读写。
//
// 官方实现：npm 源 -> `name@version`（带 registry 时一并带上）；
//           git 源 -> `git+<url>.git#<commit>`（子目录包再加 `&path:/<dir>`）。
export function installTarget(name, version) {
  const from = version.source || {};
  if (from.type === "npm") {
    return {
      spec: `${name}@${version.version}`,
      ...(from.registry === undefined ? {} : { registry: from.registry }),
    };
  }
  const url = from.url.endsWith(".git") ? from.url : `${from.url}.git`;
  const path = from.path === undefined ? "" : `&path:/${from.path}`;
  return { spec: `git+${url}#${from.commit}${path}` };
}
