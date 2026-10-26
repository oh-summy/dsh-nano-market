# Changelog（市场自身）

> 写法规则（3 行，不再另开文档）：
> ① 每个 v* tag 必配一条条目（tag = 本文件的物理载体）；条目 = 一行成果 + Added/Changed/Fixed/Removed，写"带出什么"，不写 commit 流水。
> ② 数据刷新（条目增改、ref+pin 更新）无版本、不入本文件（审计在 git）；里程碑/修复事件可记"无版本"行。
> ③ 版本号规则（x/y/z 边界、0.x 特区、1.0.0 门槛）以 **AGENTS.md §8** 为唯一事实源，本文件只记不定义。

## v0.1.0

- 2026-10-25 · 首个用户可见成果版本：monorepo 化——插件实体搬进本仓库 `plugins/dsh-remote/`（@oh-summy/dsh-remote v0.1.0），市场即插件容器（tag 指向 9cde71f：此刻 catalog 为空；首条目注册在其后合入 e9c4e26，审计在 git）。Added: 插件 house 模板落地 + in-repo 发布机制（publish-plugin.mjs）。Changed: 插件版本独立于市场 tag 演进（AGENTS §5/§8）。

## 无版本里程碑

- 2026-10-24 · P1 基建完成：管线（catalog → 生成器 commit 固定 + pinnedCommit 锁 → 官方校验器 → Pages）+ 规矩（AGENTS 红线 1-8、CONTRIBUTING 注册流程、BLOCKLIST）+ CI 门禁（PR 检查 + required build）+ Pages 上线（index.json 200）+ 审查 P0 全套。
  注：v0.1.0 按 AGENTS §8 留给 T3 首条目进场（第一个有用户可见成果的版本）——实际 tag 落在 monorepo 提交 9cde71f，首条目注册 e9c4e26 随后合入。

## 修复行（无 tag，契约不变）

- 2026-10-24 · 审查修复批：release.yml 的 `gh release create` 续行符（`\\` 在 shell 里=转义+结束命令，`--title`/`--notes` 从未生效）；双语 README 代码围栏恢复（zh-CN 内容同步到现状：preset 已砍、默认源=本市场、claude.md 为实体指针）；生成器重名条目改 fail-loud、git distTags 校验、npm author 取 dist-tags.latest；CI 改 `npm ci` + Pages 权限收窄到 deploy job；删除零消费的 sources/builtin.json；原创红线载体从 BLOCKLIST.md 改为 issue + git（AGENTS 红线 7 重写，记录不再单开文件）。
- 2026-10-24 · CI：Pages action 升到当前 v5 对（v1 钉死弃用组件被 GitHub 判死）；PR 检查触发 + per-ref 并发组（防 PR 检查误杀 main 部署）；release.yml YAML 解析修复。
- 2026-10-26 · 迭代修复批：release.yml tag 守卫漏迁（触发已改 v*、守卫仍查 refs/tags/market-：v0.1.0 推送时 job 被 skipped、Release 从未创建；修正为 refs/tags/v，--title 去掉残留 "market " 前缀，v* tag 恢复可触发发版）；CHANGELOG 补 v0.1.0 条目（规则①）；CONTRIBUTING §4 对齐 AGENTS §5（in-repo monorepo 模板）；plugins/dsh-remote/README.md 按 monorepo 现状重写（旧独立仓库 README 未同步：失效相对链接 7 处、失效外部引用若干、旧 clone 指令、v0.1.0 过时表述）。本轮不发版（AGENTS §8：CI/文档修复级变更只记 CHANGELOG，不挂 tag）。
- 2026-10-26 · 复审修复批（AI 审查 5 条发现）：CHANGELOG v0.1.0 条目修正（tag 指向 9cde71f 时 catalog 为空，首条目注册在 e9c4e26——删除「随之合入」表述）；插件 README 删除「二进制自动下载」错误声明（插件只探测不下载）+ engines.dsh 补全为 >=0.2.1-rc.2 || >=0.2.2-0；CONTRIBUTING §1 示例 ref v0.4.0→v1.0.0；失效链接计数精确化（相对链接 7 处）。
- 2026-10-26 · 工程化批（AI 工程化审查：1 major + 2 minor + nits）：publish.yml 增加插件构建同步守卫（插件 npm ci + build 后 git diff --exit-code -- plugins/dsh-remote/lib：PR 检查可见、main 推送时过期 lib/ 拦截部署）；generate.mjs 报错行号改用原始行号（空行不再错位，兑现 AGENTS §3 行号承诺）；DRY_RUN 版本恒为 0.0.0-dry（distTags.latest 不再绕过 publish.yml 的 dry 守卫）；validate.mjs 非法 JSON 报友好 INVALID index（不再裸栈）；withMeta 未知 meta 字段 fail-loud（不再静默丢弃）；测试补充 CLI 坏 JSON 原始行号 / unknown kind / DRY_RUN happy path / validate 失败分支 / withMeta 两分支，fixture 旧仓库名与 v0.4.0 中性化；release.yml --notes 措辞对齐 v* 里程碑语义。
