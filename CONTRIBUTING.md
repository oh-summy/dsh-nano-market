# CONTRIBUTING — 贡献与注册规范（dsh-nano-market）

> 一句话：**插件出现在 Discover = 注册**。注册 = 在 catalog/entries.jsonl 加一行 + PR + CI 校验 + 合入 main。
> 只提供代码（GitHub 仓库）而未注册 = 市场页面永远不可见。

## 1. 注册流程（paste-a-GitHub-URL）

1. **粘贴仓库 URL**（如 https://github.com/owner/repo）。
2. **许可自查（红线，不过 = 拒收）**：
   - 仓库有 LICENSE 且许可可用（MIT / Apache-2.0 / BSD 等）→ 可注册；
   - **无 LICENSE 文件 → 拒收**（无许可 = 默认保留所有权利，本市场不使用）；
   - 第三方代码进 manifest 之前，作者须保证代码原创或引用合规（见 §4）。
3. **结构自查**：找到声明 dsh.bundle 的目录（path，缺省 = 仓库根）；
   该目录 package.json 必须有 name、version、engines.dsh（缺就提示作者补，不替作者猜）。
4. **加一行** catalog/entries.jsonl（schema：catalog/schema.json，示例见 README）：
   - name 必须与 manifest 的 name 一致（构建器会比对，不一致 = 构建失败）；
   - ref 用 tag（vX.Y.Z 优先），构建时解析成 40-hex commit 固定；
   - meta 双语（en + zh）、category / labels 从既有 taxonomy 选（AGENTS.md §4）。
5. **开 PR → CI 绿 → 合并 = 注册完成**（Discover 立即可见；main 保护，0 评审自助合并）。

## 2. 更新与下架

- 更新 = 新 tag + 条目 ref 指向新 tag（旧版本保留在索引里，Discover 显示 update-available）。
- 下架 = 删行 + PR（市场方行为；被下架方联系负责人）。
- 市场版本 = Release tag（market-vX.Y.Z）固定存档，任何时刻可回溯到某份 index 原文。

## 3. 推送纪律（agent 与人类同等生效）

- **未经允许，禁止 git push、禁止开 PR、禁止删远端分支**（AGENTS.md 红线 6）。
  本地分支随便开、随便提交；推送 / 开 PR / 删分支一律先向负责人（oh-summy）申请。
- 一个 PR 一件事；合并完成后才可申请删除该远端分支。

## 4. 原创与抄袭（零容忍）

- 只接受**原创**贡献，或**按许可证规范署名 / 致敬**的引用（README 致敬清单 A/B/C 分级）。
- **直接复制、抄袭他人作品（代码、文案、数据、界面）= 发现即永久拉黑**：
  GitHub block、移除贡献者、下架其全部条目（AGENTS.md 红线 7）。
- 注册第三方插件时，注册者须确认作者身份 / 许可无误；拿不准就标 reference 标签并注明来源。

## 5. 插件开发 house 模板（按仓库标准方式注册）

见 AGENTS.md §5：独立仓库 + plugin/ bundle（@oh-summy/dsh-<短词>、engines.dsh 必填、
keywords 含 "dsh" 与 "dsh-plugin"、dsh.bundle.patch）+ cordis.patch.yml + GitHub topic dsh-plugin。
不按此模板的插件 = 构建器拒收（name/engines.dsh/dsh.bundle 任一缺失即失败）。
