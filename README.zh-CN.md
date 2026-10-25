# dsh-nano-market（中文）

> **结构**：本仓库是插件市场 + 插件的 monorepo——市场基建（catalog/构建/Pages）在根目录，插件实体在 `plugins/<短名>/`（如 `plugins/dsh-remote/`）。新版本一律在本仓库发布。


[中文](README.zh-CN.md) | [English](README.md)

**oh-summy 个人 DeepSeek Harness 插件市场** —— 一份人工审核收录的插件清单（catalog）、一份严格校验的[索引（format 1）](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)文档、
GitHub Pages 托管、由 DSH 原生 **Discover** 标签消费。没有第二套 UI，没有第二套安装通道——
浏览、搜索、安装全部发生在 DSH 内部。

> 成本诚实披露：P1 规模下最小真实需求只是一条安装命令
> （`dsh plugin add git+https://…#<commit>&path:/<dir>`）。市场机制（索引、CI、Pages）存在
> 还有一层原因：本仓库同时想作为一个小而成熟、工程严谨的插件市场的参考样本——
> 机制本身就是目的的一部分。

## 快速开始（3 步）

1. **这是什么**：一个策展过的 DSH 插件市场，在 DSH 原生 Discover 标签里浏览。
2. **一次性启用**：`dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle`，
   然后在 Discover 里添加本市场索引（官方支持的 10 秒操作）——或预配置你的 profile
   （本仓库 by design 不带任何独立配置文件）：
   ```yaml
   entries:
     - id: plugin-market
       service: "@deepseek-ai/dsh-plugin-market"
       config:
         indexes: ["https://oh-summy.github.io/dsh-nano-market/index.json"]
   ```

3. **随意安装**任何来源的条目，全程走 DSH 原生确认流程。装不装、何时装，永远是你自己的决定；
   本市场只负责收录审核与分发，不替你判断。

## 注册 / 上架一个插件（粘贴 GitHub URL = 注册）

出现在 Discover **就是**注册：只有 catalog 里有一行、通过 CI、合入 main 的插件才可见。
只提供代码（GitHub 仓库）而没有注册 = 市场页面永远不可见。

1. 许可自查——**无 LICENSE 文件 = 不收**（红线 1，AGENTS.md）。
2. 找到声明 dsh.bundle 的目录（path）；该 manifest 必须声明 engines.dsh。
3. 往 `catalog/entries.jsonl` 加一行 JSON（schema 见 `catalog/schema.json`）——先不填
   pinnedCommit，例如：
   ```json
   {"kind":"git","name":"@oh-summy/dsh-<短词>","repo":"https://github.com/owner/repo","path":"plugin","ref":"v1.0.0",
    "distTags":{"latest":"0.1.0"},
    "meta":{"title":{"en":"…","zh":"…"},"description":{"en":"…","zh":"…"},"icon":"icons/…","author":"…",
            "homepage":"…","repository":{"url":"https://github.com/owner/repo","directory":"plugin"},
            "category":"infra","labels":["mine"],"keywords":["…"]}}
   ```

4. 跑 `npm run pin`——ref 解析一次，40 位 commit 回填进这一行。此后每次构建都校验
   ref 解析结果 == pinnedCommit；上游移动了 tag = 构建失败，直到你有意更新 pin
   （堵住同名 tag 背后的内容静默漂移）。
5. PR → CI（测试 + 构建 + 官方校验器）→ 合并 = 注册完成。

完整规范、原创红线、推送纪律见 **CONTRIBUTING.md**（原创红线的执行载体 = `originality-violation`
issue + git 历史，见 AGENTS.md 红线 7）。

## 本地构建

```sh
npm install && npm run ci   # 测试 + 构建 + 严格 format-1 校验（官方校验器）
npm test                    # 生成器核心的离线黄金测试
DRY_RUN=1 npm run build     # 离线冒烟（占位 commit）
```

工具链：Node 24（见 `.nvmrc`，CI 钉同一大版本）。

## 信任与溯源

- 索引是**市场声明**：标题、作者、来源由本市场断言，DSH 不做验证。每次安装确认框都展示精确来源
  （npm 包 + 注册表，或 git 仓库 + commit + 目录）；安装到的 manifest 才是最终事实。
- git 条目按 commit 固定（40 位，pinnedCommit 防 tag 漂移）。审计可复现：任一历史索引 =
  checkout 那个 commit + `npm run build`。市场版本（v* tag）只标记**用户可见里程碑**——
  数据刷新（catalog 提交）不带版本（AGENTS.md §8、CHANGELOG.md）。
- 默认索引源 = 仅本市场。[awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins)
  （MIT 社区注册表）是文档级可选源：想要就在 Discover 里手动添加它的 URL
  （https://dsh.works/awesome-dsh-plugins/market/index.json，精确 URL——DSH 拒绝重定向）。
  无许可的社区索引（REALOIYO/dsh-plugin-market）按政策**仅作链接**：自行评估、风险自负；
  本市场不内置、不背书。

## 开发约定

**AGENTS.md** 是唯一事实源。
注册流程与贡献规范：**CONTRIBUTING.md**。市场自身变更记录：**CHANGELOG.md**。
