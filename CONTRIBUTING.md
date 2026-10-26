# CONTRIBUTING — 贡献与注册规范（dsh-nano-market）

> 一句话：**插件出现在 Discover = 注册**。注册 = 在 catalog/entries.jsonl 加一行（含 pinnedCommit）
> + CI 校验通过 + 合入 main。只提供代码（GitHub 仓库）而未注册 = 市场页面永远不可见。

## 1. 注册流程（paste-a-GitHub-URL）

1. **粘贴仓库 URL**（如 https://github.com/owner/repo）。
2. **许可自查（红线，不过 = 拒收；人工门——生成器不校验许可，登记前必须人工核）**：
   - 仓库有 LICENSE 且许可可用（MIT / Apache-2.0 / BSD 等）→ 可注册；
   - **无 LICENSE 文件 → 拒收**（无许可 = 默认保留所有权利，本市场不使用）；
   - 第三方代码进 manifest 前，作者须保证代码原创或引用合规（红线 7，载体 = originality-violation issue + git 历史；
     认定/下架/申诉流程见 AGENTS.md 红线 7）。
3. **结构自查**：找到声明 dsh.bundle 的目录（path，缺省 = 仓库根）；
   该目录 package.json 必须有 name、version、engines.dsh（缺就提示作者补，不替作者猜）。
4. **加一行 + 登记 pin**：
   - 往 catalog/entries.jsonl 加一行（下面有带注释模板）；此时**先不填 pinnedCommit**；
   - 跑 npm run pin：构建器解析该条目的 ref（tag 优先）→ 回填 40-hex pinnedCommit；
   - 把「条目行 + pinnedCommit」一起提交。**此后 CI 每次构建都校验 ref 解析结果 == pinnedCommit**：
     不等 = 上游 move 了 tag → 构建失败（提示：有意更新就改 pinnedCommit 重新提交，否则先还原上游 tag）。
5. **开 PR → CI 绿（构建 + 官方校验器 + 生成器测试）→ 合并 = 注册完成**（Discover 立即可见）。

带注释的条目模板（对照 catalog/schema.json；meta 双语必填 en，zh 强烈建议）：

  {"kind":"git","name":"@oh-summy/dsh-<短词>",          // 必须等于安装源 manifest 的 name（构建器比对）
   "repo":"https://github.com/owner/repo",  // 规范 https GitHub URL
   "path":"plugin",            // dsh.bundle 所在目录（缺省 = 仓库根）
   "ref":"v0.4.0",             // 人类可读别名：tag 优先（构建时解析）
   "pinnedCommit":"<40-hex>",  // npm run pin 回填；构建器校验 ref 解析必须等于它（tag 漂移即 fail）
   "distTags":{"latest":"0.1.0"},        // 市场提供的 tag→精确版本映射（可选）
   "meta":{"title":{"en":"Remote Control","zh":"远程接入"},
           "description":{"en":"…","zh":"…"},
           "icon":"icons/remote-control.svg",   // 相对引用（随 index 同目录发布）或 data:（≤32KiB）
           "author":"oh-summy",
           "homepage":"https://github.com/owner/repo",
           "repository":{"url":"https://github.com/owner/repo","directory":"plugin"},
           "category":"infra",     // 从 generate.mjs taxonomy 选（P1 单值即可）
           "labels":["mine","notifier"],
           "keywords":["remote","tunnel"]}}

## 2. 更新与下架

- 更新插件版本 = 上游打新 tag → 条目改 ref → npm run pin 回填新 pinnedCommit → PR。旧版本保留在索引里，
  Discover 显示 update-available（DSH 无原地升级：安装新版本 = 卸载旧 bundle 再装，原生确认门保障）。
- 下架 = 删行 + PR（市场方行为；被下架方联系负责人）。若涉及原创红线处分，先走 AGENTS.md 红线 7 的 issue 程序。
- 市场自身版本纪律见 **AGENTS.md §8**（数据刷新无版本；有用户可见成果才打 v* tag + Release；x/y/z 边界与 1.0.0 门槛同表）。

## 3. 推送纪律（红线 6，出处引用制）

- 任何 git push / 开 PR / 删远端分支，必须引用一条明确触发指令（用户消息 / issue / 任务单，
  写明出处与日期）；会话内许可不跨会话；PR 描述里写明触发指令出处。
- 一个 PR 一件事；feature 分支合并完成后才可申请删除该远端分支。

## 4. 插件开发 house 模板（in-repo：plugins/<短名>/）

见 AGENTS.md §5：插件实体住在本仓库 `plugins/<短名>/`（monorepo——市场即插件容器，本仓库即插件发布源）。目录内含：package.json（@oh-summy/dsh-<短词>、license MIT、engines.node、engines.dsh 必填、keywords 必含 "dsh" 与 "dsh-plugin"、dsh.bundle.patch）+ cordis.patch.yml。插件版本 = 其 package.json semver，各自独立演进；市场 tag（v*）只记市场里程碑（AGENTS §8）。不按此模板的插件 = 构建器拒收（name / engines.dsh / dsh.bundle 任一缺失即 fail，不静默跳过）。

in-repo 插件发布与收录（`node build/publish-plugin.mjs <短名>`）：把 plugins/<短名>/ 镜像到 `pkg/<短名>` 分支（插件位于分支根）并打 `<短名>@vX.Y.Z` tag——pnpm 用户 spec 无法表达「仓库+子目录」，分支根 = 普通 git spec 即可安装（Discover 实测）；catalog 条目 repo = 本仓库、无 path、ref = 该 tag、pinnedCommit = tag 解析值。源码事实源永远是 main 的 plugins/<短名>/，pkg 分支只是镜像产物。
