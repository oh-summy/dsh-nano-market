# Changelog（市场自身，不含数据刷新）

> 数据刷新（catalog 提交 + Pages 重部署）无版本号，不入本文件。本文件只记语义变更
> （管线/红线/格式/工具链），与 market-* tag 一一对应。机制见 docs/versioning.md。

## 0.1.0（market-v0.1.0）— 首个语义 Release
- 管线：catalog（entries.jsonl）→ 生成器（commit 固定 + pinnedCommit 锁 + 行号级错误定位）→ 官方校验器（整索引严格）→ GitHub Pages；
- 测试：node:test 黄金用例（合法 / 缺 engines.dsh / name 不等 / tag 漂移，离线 10 例）；
- 规矩：AGENTS.md 红线 1-8（许可/命名/索引正确性/URL/精确版本/出处引用制推送纪律/原创红线+BLOCKLIST 程序/注册定义）、
  CONTRIBUTING 注册流程（paste-GitHub-URL + npm run pin）、claude.md 实体指针；
- 砍掉（外部审查 Q4）：preset.patch.yml、Release zip 存档、marketVersion 自携带字段、sortKeys（P3）；
- 发版两分法：数据刷新无版本；语义变更 = market-* tag + 本文件一行。
