# Changelog（市场自身）

> 写法规则（3 行，不再另开文档）：
> ① 每个 v* tag 必配一条条目（tag = 本文件的物理载体）；条目 = 一行成果 + Added/Changed/Fixed/Removed，写"带出什么"，不写 commit 流水。
> ② 数据刷新（条目增改、ref+pin 更新）无版本、不入本文件（审计在 git）；里程碑/修复事件可记"无版本"行。
> ③ 版本号规则（x/y/z 边界、0.x 特区、1.0.0 门槛）以 **AGENTS.md §8** 为唯一事实源，本文件只记不定义。

## v0.1.0

- 2026-10-25 · 首个用户可见成果版本：monorepo 化——插件实体搬进本仓库 `plugins/dsh-remote/`（@oh-summy/dsh-remote v0.1.0），市场即插件容器；首条目注册（catalog 首行 + pinnedCommit 锁 + pkg/dsh-remote 镜像分支，pnpm spec 可装）随之合入。Added: 插件 house 模板落地 + in-repo 发布机制（publish-plugin.mjs）。Changed: 插件版本独立于市场 tag 演进（AGENTS §5/§8）。

## 无版本里程碑

- 2026-10-24 · P1 基建完成：管线（catalog → 生成器 commit 固定 + pinnedCommit 锁 → 官方校验器 → Pages）+ 规矩（AGENTS 红线 1-8、CONTRIBUTING 注册流程、BLOCKLIST）+ CI 门禁（PR 检查 + required build）+ Pages 上线（index.json 200）+ 审查 P0 全套。
  注：v0.1.0 按 AGENTS §8 留给 T3 首条目进场（第一个有用户可见成果的版本）。

## 修复行（无 tag，契约不变）

- 2026-10-24 · 审查修复批：release.yml 的 `gh release create` 续行符（`\\` 在 shell 里=转义+结束命令，`--title`/`--notes` 从未生效）；双语 README 代码围栏恢复（zh-CN 内容同步到现状：preset 已砍、默认源=本市场、claude.md 为实体指针）；生成器重名条目改 fail-loud、git distTags 校验、npm author 取 dist-tags.latest；CI 改 `npm ci` + Pages 权限收窄到 deploy job；删除零消费的 sources/builtin.json；原创红线载体从 BLOCKLIST.md 改为 issue + git（AGENTS 红线 7 重写，记录不再单开文件）。
- 2026-10-24 · CI：Pages action 升到当前 v5 对（v1 钉死弃用组件被 GitHub 判死）；PR 检查触发 + per-ref 并发组（防 PR 检查误杀 main 部署）；release.yml YAML 解析修复。
- 2026-10-26 · 迭代修复批：release.yml tag 守卫漏迁（触发已改 v*、守卫仍查 refs/tags/market-：v0.1.0 推送时 job 被 skipped、Release 从未创建；修正为 refs/tags/v，--title 去掉残留 "market " 前缀，v* tag 恢复可触发发版）；CHANGELOG 补 v0.1.0 条目（规则①）；CONTRIBUTING §4 对齐 AGENTS §5（in-repo monorepo 模板）；plugins/dsh-remote/README.md 按 monorepo 现状重写（旧独立仓库 README 未同步：失效链接 11 处、旧 clone 指令、v0.1.0 过时表述）。本轮不发版（AGENTS §8：CI/文档修复级变更只记 CHANGELOG，不挂 tag）。
