# Changelog（市场自身）

> 写法规则（3 行，不再另开文档）：
> ① 每个 market-* tag 必配一条条目（tag = 本文件的物理载体）；条目 = 一行成果 + Added/Changed/Fixed/Removed，写"带出什么"，不写 commit 流水。
> ② 数据刷新（条目增改、ref+pin 更新）无版本、不入本文件（审计在 git）；里程碑/修复事件可记"无版本"行。
> ③ 版本号规则（x/y/z 边界、0.x 特区、1.0.0 门槛）以 **AGENTS.md §8** 为唯一事实源，本文件只记不定义。

## 无版本里程碑

- 2026-10-24 · P1 基建完成：管线（catalog → 生成器 commit 固定 + pinnedCommit 锁 → 官方校验器 → Pages）+ 规矩（AGENTS 红线 1-8、CONTRIBUTING 注册流程、BLOCKLIST）+ CI 门禁（PR 检查 + required build）+ Pages 上线（index.json 200）+ 审查 P0 全套。
  注：market-v0.1.0 按 AGENTS §8 留给 T3 首条目进场（第一个有用户可见成果的版本）。

## 修复行（无 tag，契约不变）

- 2026-10-24 · CI：Pages action 升到当前 v5 对（v1 钉死弃用组件被 GitHub 判死）；PR 检查触发 + per-ref 并发组（防 PR 检查误杀 main 部署）；release.yml YAML 解析修复。
