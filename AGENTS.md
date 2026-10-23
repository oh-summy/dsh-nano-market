# AGENTS.md — dsh-nano-market 开发规范（人类与 AI agent 共同遵守）

> 仓库：oh-summy/dsh-nano-market（MIT，public）
> 一句话：个人 DSH 插件市场 —— 策展 catalog → 构建/校验 Format-1 索引 → GitHub Pages 托管 → DSH 原生 Discover 消费。
> 开发文档（调研/规划/执行方案）在 /Users/rocky/project/ 根目录（dsh-market-research.md、dsh-nano-market-roadmap.md、dsh-nano-market-p1-execution.md），**不进本仓库**。

## 1. 硬性红线（违反即停，必须问人）

1. **许可红线**：无 LICENSE 文件的项目（如 REALOIYO/dsh-plugin-market、cursor/community-plugins）——
   代码、数据、思想、结构**一律不采用**；唯一允许出现的方式是 README 给用户一行可选链接 + 风险自负提示。
   引用任何外部仓库前先核其 LICENSE；致敬清单写 README（A=代码依赖 / B=思想参考 / C=仅背景不算参考）。
2. **命名红线**：绝不使用/冒充 @deepseek-ai/* 等保留名；本仓库一切包名走 @oh-summy scope。
3. **索引正确性**（Format-1 生成器义务，build/generate.mjs 强制执行）：
   - 每个版本的 name/version 必须等于安装源 manifest 的值（git 源读该 commit 的 package.json，读不到 → 构建失败，不静默跳过）；
   - engines.dsh 原样拷贝 manifest 声明；缺失 → 报错（git 源）或省略该版本（npm 源）；
   - 每个列出版本必须声明 dsh.bundle；
   - git 源：规范 https URL（无尾斜杠/凭据/查询）+ 40-hex 小写 commit 固定 + 可选 ASCII path；
   - publishTimestamp：npm=注册表发布时间，git=commit 的 committer time（Unix 秒）。
4. **URL 规则**：索引必须最终地址直读（无重定向）、公网 https；awesome-dsh 索引用
   https://dsh.works/awesome-dsh-plugins/market/index.json 原样（其 github.io 地址会 301，DSH 拒重定向）。
5. **安装永远精确版本**（DSH 规则：绝不 name@latest）；市场版本 = Release tag 固定（SHA 可审计）。
6. **推送/PR 纪律（对 agent 与人类同等生效，2026-10-23 起）**：未经允许，**禁止 git push、禁止开 PR、禁止删远端分支**；
   一切工作先在本地分支完成，向负责人（oh-summy）申请许可后再推送/开 PR/删分支。agent 不得默认执行推送。
7. **抄袭零容忍（贡献红线）**：直接复制、抄袭他人作品（代码、文案、数据、界面）一律禁止；
   贡献只接受原创，或按许可证规范署名/致敬的引用。一旦发现复制抄袭 → **永久拉黑**
   （GitHub block、移除贡献者、下架其全部条目）。
8. **注册定义**：插件「出现在 Discover」= **注册**（catalog/entries.jsonl 加一行）+ CI 校验通过 + 合入 main。
   **只提供代码（GitHub 仓库）而未注册 = 市场页面永远不可见**。注册流程见 CONTRIBUTING.md。

## 2. 分支与推送纪律（main 已启用分支保护）

- main 禁止直推 / force push / 删除（admin 同样受限）；一切改动 = feature 分支 → PR → 合并（0 评审，自助）。
- **未经允许不推送、不开 PR、不删远端分支**（红线 6）；合并后的 feature 分支才谈得上删除（先要许可）。
- 合入 main 触发 publish.yml → Pages 更新；打 market-* tag 触发 release.yml → Release 存档。
- 小步 PR：一个 PR 一件事。

## 3. 构建与验证（本地命令）

npm install            # 首次（devDeps: @deepseek-ai/dsh-plugin-market-index，MIT，官方校验器）
npm run build          # node build/generate.mjs → dist/index.json（+ catalog/icons → dist/icons）
npm run validate       # node build/validate.mjs dist/index.json（官方校验器严格校验，整索引拒绝=失败）
npm run ci             # build + validate（PR 必须绿）
DRY_RUN=1 npm run build  # 离线冒烟：git 条目不真实解析（占位 commit），仅验证管线

## 4. catalog 约定（catalog/entries.jsonl）

- 每行一个 JSON 对象；schema 见 catalog/schema.json；行 schema 变更 = 改 schema.json + 改 generate.mjs 同一个 PR。
- 字段：kind（git|npm|local；local 仅开发不进构建）、name、repo（规范 https GitHub URL）、path（包目录，缺省=根）、
  ref（tag 优先，构建时解析为 commit 固定）、registry（npm 可选）、distTags（市场提供的 tag→版本映射）、
  meta（双语 title/description、icon、author、homepage、repository、category、labels、keywords、sortKeys）。
- 加条目 = 加一行 + 一个 PR（CONTRIBUTING 有流程）；粘贴别人的 GitHub URL 上架前：
  先核该仓库许可（红线 1）、找 dsh.bundle 所在目录（path）、确认 manifest 有 engines.dsh（没有提示作者补）。
- taxonomy v0（写死在 generate.mjs 的 MARKET.metadata）：
  categories：infra / workflow / skills / tools / ui；labels：mine / experimental / notifier / needs-env / reference。

## 5. 插件 house 模板（每个插件仓库长这样，README 有示例段）

- 独立 GitHub 仓库 + plugin/（或根目录）bundle：package.json
  （@oh-summy/dsh-<短词>、license MIT、engines.node、engines.dsh 必填、
  keywords 必含 "dsh" 与 "dsh-plugin"、dsh.bundle.patch）+ cordis.patch.yml；
- 仓库加 GitHub topic dsh-plugin（可发现性）；发 tag vX.Y.Z → 本市场 catalog 的 ref 指向它。

## 6. 环境与账号

- 本地 gh 双账号：默认 OneSami；操作 oh-summy 仓库先 gh auth switch --user oh-summy，完事切回（只读操作可随手做，写操作=红线 6）。
- agent 入口：`claude.md` 是 `AGENTS.md` 的符号链接（Claude 系 agent 读 claude.md）；**唯一事实来源永远是 AGENTS.md**，只改它。
  本仓库 remote 走 git@github-personal:oh-summy/dsh-nano-market（SSH 别名，与 remote-control 一致）。
- DSH 本机 0.2.1-rc.2；web profile 在 ~/.dsh/profiles/web（patchReload live）。
- 内置源清单：sources/builtin.json（本市场 + awesome-dsh-plugins）；DSH 侧配置片：install/preset.patch.yml。

## 7. 变更节奏（对应 P1 执行方案）

T0 骨架 ✅ → T1 本管线（feat/p1）→ T2 宿主工具注册 spike → T3 remote-control 打包（@oh-summy/dsh-remote）
→ T4 内置源/preset → T5 DSH 端到端 → T6/T7 粘贴上架流程文档 + 致敬 README → 合并 = P1 发布（market-v0.1.0）。
P2 见 /Users/rocky/project/dsh-nano-market-roadmap.md。
