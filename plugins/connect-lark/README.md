# @oh-summy/connect-lark

飞书 / Lark 长连接桥接插件：把飞书消息接到本地 DSH agent，回复以富卡片流式返回。

## Quick Start

1. **安装**（从市场或直接，**当前未注册，请用 git 方式安装**）：
   ```sh
   dsh plugin --profile web add git+https://github.com/oh-summy/dsh-nano-market.git#main&path:/plugins/connect-lark
   ```
2. **配置**：在 Plugins 页找到 connect-lark，填写 App ID 和 App Secret 凭据引用。国内飞书与海外 Lark 可直接切换。
3. **默认即可**：工作区、模型和思考强度默认跟随 DSH；每个聊天使用独立 Agent。私聊默认允许所有用户，群聊默认需要 @ 机器人。
4. **启用**：打开插件本身的开关即连接；关闭插件即断开，没有第二个启用开关。
5. **验证**：在飞书里给机器人发一条消息，应该收到回复。

## 功能

- 飞书私聊 / 群 @ → 流式富卡片回复（Markdown：粗体 / 列表 / 表格 / 代码 / 链接）
- 标题 + 背景色、底部小字、按钮（需要调用方提供原始 CardKit JSON）
- 发送图片
- 读取 / 识别图片：下载 → attachment admission → 视觉 gate → 否则诚实汇报
- 两种 agent 所有权模式：attach-gui / owned-per-chat

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `appId` | `""` | 飞书自建应用 App ID |
| `appSecretRef` | `CONNECT_LARK_APP_SECRET` | App Secret 的 DSH 凭据缝引用名，不保存明文 Secret |
| `defaultPath` | `""` | 默认工作区绝对路径；留空使用宿主 cwd |
| `domain` | `feishu` | 国内飞书或海外 Lark |
| `provider` / `model` | `""` | 留空跟随 DSH 当前模型 |
| `reasoningEffort` | `""` | 留空跟随所选模型的默认思考强度 |
| `agentOwnership` | `owned-per-chat` | 默认每个聊天独立 Agent；`attach-gui` 仅高级场景使用 |
| `requireMention` | `true` | 群聊需要 @ 机器人 |
| `senderAllowlist` | `[]` | 可选私聊用户限制；留空允许所有私聊用户 |
| `groupAllowlist` | `[]` | 可选群聊限制；留空允许所有群聊 |

插件本身的启用开关直接控制连接生命周期。旧 `enabled` 配置字段仅为兼容保留，不再作为第二个开关。

## 致谢与参考

本插件的设计与实现参考了以下项目：

| 类型 | 项目 | 许可 | 参考内容 |
|---|---|---|---|
| A 代码依赖 | @larksuite/channel | MIT | 飞书长连接 + 流式卡片 + send + 扫码 registerApp |
| A 代码依赖 | @larksuiteoapi/node-sdk | MIT | 备用低层 SDK；`rawClient` 逃生舱；底层 WSClient 属本包 |
| A 代码依赖 | @deepseek-ai/schemastery | MIT | 配置 schema（dsh-settings 只接受带 `toJSON()` 的 schema） |
| A 代码依赖 | @deepseek-ai/cosmokit | MIT | `isVolatile()` 判定 volatile 字段（`plainConfig` 解包用） |
| A 代码依赖 | @deepseek-ai/dsh-llm | MIT | `createUserMessage()` 独立函数（不是 Session 方法） |
| A 代码依赖 | @deepseek-ai/dsh-credentials | MIT | 凭据缝（`credentialRef` / `isCredentialRefName`） |
| B 思想参考 | omdsh-dev/dsh-lark | BSD-3-Clause | 原生 CoT 思路 · 卡片 footer/button/主题色 · registerApp · in-process 驱动 agent · 客户端版本要求 |
| B 思想参考 | sugarforever/dsh-lark | MIT | in-process 驱动 agent + chatId→Session 映射 + 长连接骨架 |
| B 思想参考 | amlyczz/dsh-lark-link | MIT | 扫码 one-click · outbox |
| B 思想参考 | bihangchi9-creator/lark-agent-bridge | MIT | 二创 reimplementation 的署名先例 |
| C 仅背景 | PlutoKeating/dsh-lark-bot | AGPL-3.0 | 不抄代码（copyleft）；npm 撞名，命名避开 -bot |
| C 仅链接 | AX1202/ax-feishu-bridge | 无 LICENSE | [https://github.com/AX1202/ax-feishu-bridge](https://github.com/AX1202/ax-feishu-bridge) — 不内置、不采用；风险自负 |

## License

MIT。非官方社区插件，与 DeepSeek / 飞书 / Lark 不存在隶属、授权或背书关系。