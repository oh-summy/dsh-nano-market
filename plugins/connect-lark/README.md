# @oh-summy/connect-lark

飞书 / Lark 长连接桥接插件：把飞书消息接到本地 DSH agent，回复以富卡片流式返回。

## Quick Start

1. **安装**（从市场或直接，**当前未注册，请用 git 方式安装**）：
   ```sh
   dsh plugin --profile web add git+https://github.com/oh-summy/dsh-nano-market.git#main&path:/plugins/connect-lark
   ```
2. **配置**：在 Plugins 页找到 connect-lark，填入：
   - `appId`：飞书自建应用 App ID
   - `appSecretRef`：App Secret 的凭据缝引用名（默认 `CONNECT_LARK_APP_SECRET`）
   - `agentOwnership`：`attach-gui`（默认，复用宿主 agent）或 `owned-per-chat`（插件自建）
   - `attachSessionId`：attach-gui 模式下的目标 session id
   - `provider` / `model`：owned-per-chat 模式下必填
   - `senderAllowlist` / `groupAllowlist`：**两者都必须配置**，任何一个为空 = 该维度拒绝全部（fail-closed）
3. **启用**：打开 `enabled` 开关，重启宿主。
4. **验证**：在飞书里给机器人发一条消息，应该收到回复。

## 功能

- 飞书私聊 / 群 @ → 流式富卡片回复（Markdown：粗体 / 列表 / 表格 / 代码 / 链接）
- 标题 + 背景色、底部小字、按钮（需要调用方提供原始 CardKit JSON）
- 发送图片
- 读取 / 识别图片：下载 → attachment admission → 视觉 gate → 否则诚实汇报
- 两种 agent 所有权模式：attach-gui / owned-per-chat

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 启用飞书连接 |
| `appId` | string | `""` | 飞书 App ID |
| `appSecretRef` | string | `CONNECT_LARK_APP_SECRET` | App Secret 凭据缝引用名 |
| `defaultPath` | string | `""` | 默认工作区路径（留空=宿主 cwd） |
| `openId` | string | `""` | 你的 open_id |
| `domain` | `feishu` | `lark` | `feishu` | 飞书或 Lark |
| `requireMention` | boolean | `true` | 群聊需 @ 机器人才触发 |
| `agentOwnership` | `owned-per-chat` | `attach-gui` | `attach-gui` | agent 所有权 |
| `attachSessionId` | string | `""` | attach-gui 目标 session id |
| `provider` | string | `""` | owned-per-chat 时必填 |
| `model` | string | `""` | owned-per-chat 时必填 |
| `senderAllowlist` | string[] | `[]` | sender 白名单（空=拒绝全部） |
| `groupAllowlist` | string[] | `[]` | 群 chat_id 白名单（空=拒绝全部） |
| `thinkingPolicy` | `cot-visible` | `cot-discard` | `stream-only` | `stream-only` | CoT 政策（stream-only=不显示思考过程） |

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