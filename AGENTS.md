# AGENTS.md — dsh-nano-market 开发规范（人类与 AI agent 共同遵守）

> 仓库：oh-summy/dsh-nano-market（MIT，public）
> 一句话：个人 DSH 插件市场 —— 策展 catalog → 构建/校验 Format-1 索引 → GitHub Pages 托管 → DSH 原生 Discover 消费。
> 开发文档（调研/规划/执行方案）在 /Users/rocky/project/ 根目录（dsh-market-research.md、dsh-nano-market-roadmap.md、dsh-nano-market-p1-execution.md），**不进本仓库**。

## 1. 硬性红线（违反即停，必须问人）

1. **许可红线**：无 LICENSE 文件的项目（如 REALOIYO/dsh-plugin-market、cursor/community-plugins）——
   代码、数据、思想、结构**一律不采用**；唯一允许出现的方式是 README 给用户一行可选链接 + 风险自负提示。
   引用任何外部仓库前先核其 LICENSE；致敬清单写 README（A=代码依赖 / B=思想参考 / C=仅背景不算参考）。
2. **命名红线**：绝不使用/冒充 @deepseek-ai/* 等保留名；本仓库一切包名走 @oh-summy scope；插件名不以 `dsh-` 开头（host 标签由 keywords 承载，见 §5）。
   **过渡豁免（2026-10-27 订正）**：此约定 2026-10-27 才定，早于此的既有插件不受其约束——本仓库**已注册**的 `@oh-summy/dsh-remote`（catalog 行、tag `dsh-remote@v0.2.0`、`pkg/dsh-remote` 分支、README、CI 守卫）沿用原名。新增插件一律遵守本约定。改名 dsh-remote → remote-control 是**待办**（Issue #16 OPEN；main 分支保护已启用，改名涉及远端历史处理），不是既成事实。
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
   **范围字面制（2026-10-23 事故后追加）**：触发指令的**范围由下达者决定，agent 不得外推**——
   「做 A、B」不构成「顺带做 C」的许可；工作一旦超出指令字面范围，必须停下、列出超出部分、
   等待补充授权（一句话即可，但必须是新指令）。「这次就算了」不构成下次的先例。
7. **原创红线（可执行版）**：认定标准（客观）——与在先作品代码实质相同或派生，且未满足其许可证要求或未署名。
   程序（载体 = issue + git，不单开文档）：发现 → 开 issue 标 originality-violation（证据链接 + 认定日期）→
   被列方可在 issue 内申诉，维护者 14 天内回应 → 处分 = 相关条目 catalog 删行 + 拒重新收录；
   「永久」不预设，重犯在 issue 打 Permanent 标。不预设道德宣告式处罚，只用「下架 + 记录 + 可申诉」。
8. **注册定义**：插件「出现在 Discover」= **注册**（catalog/entries.jsonl 加一行，含 pinnedCommit）+ CI 校验通过 + 合入 main。
   **只提供代码（GitHub 仓库）而未注册 = 市场页面永远不可见**。注册流程见 CONTRIBUTING.md。
   **发版机制（版本纪律，§8 为唯一事实源，不再单开 versioning 文档）**：数据刷新（catalog 提交 + Pages 重部署）无版本号；
   **有用户可见成果才打 v* tag + Release**（v0.1.0 起，无前缀）。市场版本 = git tag（索引内不携带版本号）。

## 2. 分支与推送纪律（main 已启用分支保护）

- main 禁止直推 / force push / 删除（admin 同样受限）；一切改动 = feature 分支 → PR → 合并（0 评审，自助）。
- **未经允许不推送、不开 PR、不删远端分支**（红线 6）；**任何时候禁止 agent 自行合并 PR——合并只由负责人操作**（2026-10-25 负责人明令）。合并后的 feature 分支才谈得上删除（先要许可）。
- **推送后必验（agent 义务，2026-10-23 起）**：每次 push / 开 PR 后，立即自查并向负责人报告：
  ① rebase 是否真完成（半途 rebase 遗留是事故来源——2026-10-23 PR #4 README 冲突即此因）；
  ② PR 可合并性（mergeable / 冲突）与 check 状态；③ 远端分支 tip 是否已更新。没验完不算推完，不等人来查。
- 合入 main 触发 publish.yml → Pages 更新；打 v* tag 触发 release.yml → Release 存档。
- 小步 PR：一个 PR 一件事。

## 3. 构建与验证（本地命令）

npm install            # 首次（devDeps: @deepseek-ai/dsh-plugin-market-index，MIT，官方校验器）
npm run build          # node build/generate.mjs → dist/index.json（+ catalog/icons → dist/icons）
npm run validate       # node build/validate.mjs dist/index.json（官方校验器严格校验，整索引拒绝=失败）
npm run ci             # npm test && npm run build && npm run validate（PR 必须绿）
npm test               # 市场生成器断言测试（node --test test/**/*.test.mjs：合法 / 缺 engines.dsh / name 不等 黄金用例 + pin 锁 / distTags / author / CLI 重名，全离线）
npm run pin            # 新增条目后：解析 ref → 回填 pinnedCommit（首次登记），再提交
DRY_RUN=1 npm run build  # 离线冒烟：git 条目不真实解析（占位 commit），仅验证管线
插件测试 = 插件自己的 `npm test`（在 plugins/<名>/ 下跑），不进根 npm test——根测试只覆盖市场管线。
CI 的插件守卫遍历所有 plugins/*/ 自动纳入（有 lockfile 才 `npm ci` → 有 build 脚本才构建 → 有 test 脚本才跑插件测试 → `git status --porcelain -- <plugin>/lib` 判脏/未跟踪）。
**不要用 `git diff --exit-code`**——它漏掉未跟踪文件，忘提交 lib/ 会假绿。
**lib/ 必须存在**——市场装的就是 lib/，构建后没产出 lib/ 视为失败。
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
- taxonomy v0（写死在 `build/lib.mjs` 的 `MARKET.metadata`；`generate.mjs` 只是 import 并消费）：
  categories：infra / workflow / skills / tools / ui；labels：mine / experimental / notifier / needs-env / reference。

## 5. 插件 house 模板（**插件住在本仓库 plugins/<短名>/**，market 即插件的容器——monorepo）

- 每个插件一个目录 plugins/<短名>/（如 plugins/connect-lark/），内含：package.json
  （@oh-summy/<短词>、license MIT、engines.node、engines.dsh 必填、
  keywords 必含 "dsh" 与 "dsh-plugin"、dsh.bundle.patch）+ cordis.patch.yml；
  **命名约定（2026-10-27 定）**：插件名**不以 `dsh-` 开头**（如同 connect-lark；dsh-remote 是 §1.2 的过渡豁免项）。host 标签/可发现性由 keywords（必含 `dsh`/`dsh-plugin`）承载，市场管线不强制包名含 dsh。
   **可发现性事实（2026-10-27 订正，勿写错）**：DSH Discover 的搜索**确实依赖名字**——`dsh-plugin-market` 的 MiniSearch 字段为 name/title/keywords/description/author/taxonomy，权重 `name: 3, title: 3, keywords: 2`。所以去掉 `dsh-` 前缀**不妨碍被列出和检索**，但「搜索排序完全不受影响」「名字不参与搜索」都不成立。另外 `package.json` keywords 与市场 keywords 是**两条链路**：npm 搜索用包 manifest，本市场索引用的是 catalog 的 `meta.keywords`（`build/lib.mjs` 的 withMeta，不会自动从 git 源 package.json 复制）——**两者都要保留**。GitHub 仓库 About/Topics 属仓库展示设置，不是 Discover 可发现性的替代或必要条件。
- 插件版本 = 其 package.json 的 semver，各自独立演进；市场 tag（v*，本仓库）记市场里程碑。

## 6. 环境与账号

- 本地 gh 双账号：默认 OneSami；操作 oh-summy 仓库先 gh auth switch --user oh-summy，完事切回（只读操作可随手做，写操作=红线 6）。
- agent 入口：`claude.md` 是一个 3 行**实体指针文件**（不是软链——Windows core.symlinks=false 检出时软链会退化成
  内容为裸路径的文本，被 agent 误读；实体指针文件全平台一致）。指针只写「规范在 AGENTS.md，本文件不得承载规范内容」；
  **唯一事实来源永远是 AGENTS.md**，只改它。
  本仓库 remote 走 git@github-personal:oh-summy/dsh-nano-market（SSH 别名 `github-personal`，指向 oh-summy 的 GitHub 账号）。
- DSH 本机 0.2.1-rc.4（2026-10-27 实测 checkout；此前文档写 rc.2 已过时）；web profile 在 ~/.dsh/profiles/web（patchReload live）。
  服务名事实（插件注入用）：`ctx.agents`（AgentRegistry，`create`/`resume` → AgentHandle）、`ctx.sessions`（SessionStore）、`ctx.attachments`（AttachmentStore，`saveImages`）、`ctx.llm`（`resolveModelInfo` → inputModalities）、`ctx.credentials`。早期文档里写的 `ctx.agent`/`ctx.session` **不存在**（应为 `ctx.agents`/`ctx.sessions`）。
- 本地工具链：Node 24（.nvmrc 与 CI 双钉，本地安装保持同一大版本；升级 = 有意的 PR，安全补丁优先跟进）。
  其他语言（Go/Python/Rust…）的工具链属于各插件仓库自身的契约（.nvmrc / rust-toolchain / go.mod 同理），本仓库不声明。
- 内置源：默认 = 本市场（https://oh-summy.github.io/dsh-nano-market/index.json）；DSH 侧索引源在 Discover 手工添加
  （官方支持的 10 秒操作），README 附 YAML 片段——仓库不维护任何配置文件副本；
  awesome-dsh-plugins 只是 README 文档级可选源（策展身份优先）。

## 7. 变更节奏（对应 P1 执行方案）

T0 骨架 ✅ → T1 本管线（feat/p1，已合并）→ **外部审查 P0 修订**（feat/conventions：红线 6/7 可执行化、claude.md 实体指针、
CONTRIBUTING pin 流程；feat/review-fixes：生成器 fixtures/测试、tag pinnedCommit 锁、砍 preset/zip/marketVersion、
发版机制两分法）→ T2 宿主工具注册 spike → T3 dsh-remote 打包（@oh-summy/dsh-remote，首个条目含 pinnedCommit）
→ T5 DSH 端到端（Discover 手工加源 + 安装冒烟）→ 合并 = P1 基建完成（无版本里程碑；**v0.1.0 留给 T3 首条目进场**）。
P2 见 /Users/rocky/project/dsh-nano-market-roadmap.md。

## 8. 版本纪律（v* tag，无前缀；唯一事实源在此；CONTRIBUTING/CHANGELOG 只引用不复制）

**打 tag 的触发条件 = 有用户可见成果**：首条目注册 / 新增条目达到里程碑 / taxonomy 大调整 / 管线契约变更。
空目录基建完成、CI 修复级变更 = 只记 CHANGELOG 里程碑/修复行，不挂 tag。

| 位 | 何时 +1 | 例子 |
|---|---|---|
| **x（major）** | 契约破坏：catalog schema 字段变、URL/注册流程变、安装 spec 变、影响全部存量条目的红线收紧 | 仅 1.0 后使用（如 1.0→2.0） |
| **y（minor）** | 有用户可见新成果：首条目（= 0.1.0）、新增条目、taxonomy 新类别、管线新功能（CLI） | 0.2.0 |
| **z（patch）** | 契约不变的修复：CI/校验器/文档修复、bug fix | 0.1.1 |
| 无 tag | 数据刷新（条目增改、ref+pin 更新）：只部署 Pages，审计在 git | — |

**边界注记（写明，不靠默契）**：
1. 0.x 特区：semver 官方规则 0.x = 开发期，**breaking 可只升 y**；到达 1.0.0 后一切 breaking 必须升 x。
2. **1.0.0 准入门槛（4 条全过）**：≥3 个真实可装条目且各走过一次更新 / P2 CLI 落地 / catalog schema 连续 4 周零 breaking / 负责人宣布契约冻结。
3. 插件包版本（plugins/<name>/package.json）各自独立演进，与本表无强制联动；市场 tag（v*）只记市场自身里程碑。
   **in-repo 插件的发布与收录**：`node build/publish-plugin.mjs <name>` 把 plugins/<name>/ 镜像到分支 `pkg/<name>`（插件位于分支根）并打 `<name>@vX.Y.Z` tag；catalog 条目 repo = 本仓库、**无 path**、ref = 该 tag、pinnedCommit = tag 解析值。原因：pnpm 用户 spec 无法表达「仓库+子目录」，分支根 = 普通 git spec 即可安装（Discover 实测）。源码事实源永远是 main 的 plugins/<name>/，pkg 分支只是镜像产物。
