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
6. **推送/PR 纪律（出处引用制，对 agent 与人类同等生效）**：任何 git push / 开 PR / 删远端分支，
   必须能引用一条明确的**触发指令**（当前会话的用户消息、issue 或任务单，写明出处与日期）；
   无法引用触发指令的操作一律禁止。会话内许可不跨会话；每次 push/PR 在描述中写明触发指令出处。
   （判定标准 = 「能否引用出处」，不是「感觉被允许过」。）
7. **原创红线（可执行版）**：认定标准（客观）——与在先作品代码实质相同或派生，且未满足其许可证要求或未署名。
   程序（BLOCKLIST.md 为唯一载体）：发现 → BLOCKLIST.md 记录条目/证据链接/认定日期 → 被列方可开 issue 申诉，
   维护者 14 天内回应 → 处分 = 相关条目从 catalog 下架并拒绝重新收录；「永久」不预设，**重犯才加 Permanent 标记**。
   不预设道德宣告式处罚，只用「下架 + 记录 + 可申诉」三步可执行流程。
8. **注册定义**：插件「出现在 Discover」= **注册**（catalog/entries.jsonl 加一行，含 pinnedCommit）+ CI 校验通过 + 合入 main。
   **只提供代码（GitHub 仓库）而未注册 = 市场页面永远不可见**。注册流程见 CONTRIBUTING.md。
   **发版机制（版本策略，docs/versioning.md 为唯一事实源）**：数据刷新（catalog 提交 + Pages 重部署）无版本号；
   只有语义变更（生成器/校验器/红线/格式）才打 market-* tag + Release。市场版本 = git tag（索引内不再自携带 marketVersion）。

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
npm test               # 生成器断言测试（node --test：合法/缺 engines.dsh/name 不等 三个黄金用例，离线）
npm run pin            # 新增条目后：解析 ref → 回填 pinnedCommit（首次登记），再提交
DRY_RUN=1 npm run build  # 离线冒烟：git 条目不真实解析（占位 commit），仅验证管线
构建失败的定位标准：第一条错误必须含 catalog 行号 + 仓库 + 缺什么，不打开生成器源码也能修（验收标准）。

## 4. catalog 约定（catalog/entries.jsonl）

- 每行一个 JSON 对象；schema 见 catalog/schema.json；行 schema 变更 = 改 schema.json + 改 generate.mjs 同一个 PR。
- 字段：kind（git|npm|local；local 仅开发不进构建）、name、repo（规范 https GitHub URL）、path（包目录，缺省=根）、
  ref（tag 优先）+ **pinnedCommit（必填，40-hex；构建时校验 ref 解析结果必须等于 pinnedCommit，
  不等 = tag 被 move，fail 并提示「有意更新就改 pinnedCommit，无意见就还原 tag」——堵住同名 tag 内容漂移）**、
  registry（npm 可选）、distTags（市场提供的 tag→版本映射）、
  meta（双语 title/description、icon、author、homepage、repository、category、labels、keywords）。
  sortKeys（stars/downloads 统计）= P3 项，P1/P2 不生成（策展顺序 = catalog 行顺序；与 review-fixes 的 schema 同步，防双事实源）。
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
- agent 入口：`claude.md` 是一个 3 行**实体指针文件**（不是软链——Windows core.symlinks=false 检出时软链会退化成
  内容为裸路径的文本，被 agent 误读；实体指针文件全平台一致）。指针只写「规范在 AGENTS.md，本文件不得承载规范内容」；
  **唯一事实来源永远是 AGENTS.md**，只改它。
  本仓库 remote 走 git@github-personal:oh-summy/dsh-nano-market（SSH 别名，与 remote-control 一致）。
- DSH 本机 0.2.1-rc.2；web profile 在 ~/.dsh/profiles/web（patchReload live）。
- 内置源：sources/builtin.json（默认 = 本市场；awesome-dsh-plugins 降级为 README 文档级可选源——
  策展身份优先；DSH 侧索引源在 Discover 手工添加（官方支持的 10 秒操作），README 附 YAML 片段，不再维护第二份配置格式。

## 7. 变更节奏（对应 P1 执行方案）

T0 骨架 ✅ → T1 本管线（feat/p1，已合并）→ **外部审查 P0 修订**（feat/conventions：红线 6/7 可执行化、claude.md 实体指针、
CONTRIBUTING pin 流程、BLOCKLIST；feat/review-fixes：生成器 fixtures/测试、tag pinnedCommit 锁、砍 preset/zip/marketVersion、
发版机制两分法）→ T2 宿主工具注册 spike → T3 remote-control 打包（@oh-summy/dsh-remote，首个条目含 pinnedCommit）
→ T5 DSH 端到端（Discover 手工加源 + 安装冒烟）→ 合并 = P1 发布（market-v0.1.0 语义 Release）。
P2 见 /Users/rocky/project/dsh-nano-market-roadmap.md。
