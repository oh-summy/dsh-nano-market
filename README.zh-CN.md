# dsh-nano-market（中文）

[中文](README.zh-CN.md) | [English](README.md)

**oh-summy 的 DSH 纳米市场** —— 一个个人的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
插件市场：一份策展 catalog、一份严格校验的 [索引（format 1）](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)、
GitHub Pages 托管、由 DSH 原生 **Discover** 标签消费。没有第二套 UI，没有第二套安装通道——
浏览、搜索、安装全部发生在 DSH 内部。

## 快速开始

1. 在你的 DSH web profile 里启用实验市场 bundle，并预置内置索引源：

   代码块 sh：
   dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle
   然后：把 install/preset.patch.yml 的内容追加到 ~/.dsh/profiles/web/cordis.patch.yml；
   或者不碰 profile 先试跑：dsh web --patch /path/to/install/preset.patch.yml

2. Web UI：**Plugins → More（Experimental plugins）→ 打开 “Custom plugin markets”**。
   **Discover** 标签打开时已列出全部内置源（本市场 + awesome-dsh-plugins），直接逛。

3. 任何市场里的条目都可经 DSH 原生确认流程安装。**装不装、何时装，永远是你自己的决定**；
   内置源只是「打开即可逛」的默认清单。

## 注册 / 上架一个插件（粘贴 GitHub URL 流程）

1. **许可自查**：目标仓库必须有可用 LICENSE——**无 LICENSE = 不收**（许可红线，见 AGENTS.md）。
2. **结构自查**：找到声明 dsh.bundle 的目录（path），确认其 package.json 有 name、version、engines.dsh。
3. **注册**：往 catalog/entries.jsonl 加一行 JSON（schema 见 catalog/schema.json）：

   代码块 json：
   {"kind":"git","name":"@oh-summy/dsh-<短词>","repo":"https://github.com/owner/repo","path":"plugin","ref":"v1.0.0",
    "distTags":{"latest":"0.1.0"},
    "meta":{"title":{"en":"…","zh":"…"},"description":{"en":"…","zh":"…"},"icon":"icons/…","author":"…",
            "homepage":"…","repository":{"url":"https://github.com/owner/repo","directory":"plugin"},
            "category":"infra","labels":["mine"],"keywords":["…"]}}

4. **开 PR → CI 构建 + 官方校验器严格校验 → 合并 = 注册完成**（Discover 立即可见，
   git 源在构建时解析为 40 位 commit 固定；name/engines.dsh/dsh.bundle 缺失或不等 = 构建失败）。

完整注册/贡献规范（含抄袭零容忍、推送纪律）见 **CONTRIBUTING.md**。

## 本地构建

代码块 sh：
npm install && npm run ci        # 构建 + 严格 format-1 校验（官方校验器）
DRY_RUN=1 npm run build          # 离线冒烟（不解析 git 源）

## 信任与溯源

- 索引是**市场声明**：标题、作者、来源由本市场策展，DSH 不背书；每次安装确认框都展示精确来源
  （npm 包 + 注册表，或 git 仓库 + commit + 目录），安装后的 manifest 才是最终事实。
- git 条目按 40 位 commit 固定；市场按 Release tag（market-vX.Y.Z）存档，任何一份历史索引都可追溯。
- 内置源：本市场 + [awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins)
  （MIT 开放数据注册表，20k+ 条目）。未授权的社区索引（REALOIYO/dsh-plugin-market）**仅作链接**：
  你可以自行评估风险后在 Discover 里手动添加，本市场不内置、不背书。

## 开发约定

开发规范（人类与 AI agent 共同遵守）见 **AGENTS.md**（Claude 系 agent 经 claude.md 符号链接读取同一份）。
