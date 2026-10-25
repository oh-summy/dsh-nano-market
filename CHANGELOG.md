# Changelog（市场自身）

> 写法规则（3 行，不再另开文档）：
> ① 每个 v* tag 必配一条条目（tag = 本文件的物理载体）；条目 = 一行成果 + Added/Changed/Fixed/Removed，写"带出什么"，不写 commit 流水。
> ② 数据刷新（条目增改、ref+pin 更新）无版本、不入本文件（审计在 git）；里程碑/修复事件可记"无版本"行。
> ③ 版本号规则（x/y/z 边界、0.x 特区、1.0.0 门槛）以 **AGENTS.md §8** 为唯一事实源，本文件只记不定义。

## 无版本里程碑

- 2026-10-24 · P1 基建完成：管线（catalog → 生成器 commit 固定 + pinnedCommit 锁 → 官方校验器 → Pages）+ 规矩（AGENTS 红线 1-8、CONTRIBUTING 注册流程、BLOCKLIST）+ CI 门禁（PR 检查 + required build）+ Pages 上线（index.json 200）+ 审查 P0 全套。
  注：v0.1.0 按 AGENTS §8 留给 T3 首条目进场（第一个有用户可见成果的版本）。

## 修复行（无 tag，契约不变）

- 2026-10-24 · 审查修复批：release.yml 的 `gh release create` 续行符（`\\` 在 shell 里=转义+结束命令，`--title`/`--notes` 从未生效）；双语 README 代码围栏恢复（zh-CN 内容同步到现状：preset 已砍、默认源=本市场、claude.md 为实体指针）；生成器重名条目改 fail-loud、git distTags 校验、npm author 取 dist-tags.latest；CI 改 `npm ci` + Pages 权限收窄到 deploy job；删除零消费的 sources/builtin.json；原创红线载体从 BLOCKLIST.md 改为 issue + git（AGENTS 红线 7 重写，记录不再单开文件）。
- 2026-10-24 · CI：Pages action 升到当前 v5 对（v1 钉死弃用组件被 GitHub 判死）；PR 检查触发 + per-ref 并发组（防 PR 检查误杀 main 部署）；release.yml YAML 解析修复。
