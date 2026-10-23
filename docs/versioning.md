# 版本策略（唯一事实源）

## 两个概念，必须分清

| 概念 | 触发 | 产物 | 版本号 |
|---|---|---|---|
| 数据刷新 | catalog 任意提交（加/改/删条目）合入 main | Pages 自动重部署 | **无** |
| 语义变更 | 管线/校验器/红线/格式/工具链变更合入 main | 打 market-* tag + Release | market-vX.Y.Z |

- 数据刷新的审计由 git 承担：每条 catalog 行携带 40-hex pinnedCommit，任何历史时刻的索引可
  checkout 旧 commit + npm run build 精确复算。Release 不再附 zip（zip 是更弱的第二事实源）。
- 插件发版（上游打新 tag）≠ 市场动作：catalog 不改 ref/pin = 索引逐字节不变，市场不发任何东西。
- 更新插件版本 = 改条目 ref + npm run pin 回填新 pinnedCommit + 提交（= 一次数据刷新）。

## 拒绝的方案（及理由）

- 夜间自动滚动（REALOIYO 式）：破坏「每条索引条目对应一次人的判断」，市场声明须过人；
  替代 = P2 的 weekly 只读检测 job（检测上游新 tag，开 issue/PR 提议，人裁决，自动化不写入）。
- Release 随数据出 zip：双事实源漂移；git + 40-hex pin 已给出可复算审计。

## 退出路径（Q5-1）

DSH 官方市场 GA / Format-2 出现时：catalog 是资产、序列化是耗材（生成器加 --format 双输出，
Format-1 保留到宿主弃用）；把自家 catalog 登记进 awesome-dsh-plugins（登记处越多，URL 变更时
断链可发现性越好）。不加自定义域名：DSH 拒重定向，域名是唯一不能反悔的基础设施决定。
