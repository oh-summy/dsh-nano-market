# @oh-summy/connect-lark

飞书 / Lark 长连接桥接插件：把飞书消息接到本地 DSH agent，回复以富卡片流式返回。

## Quick Start

1. **安装**：从 DSH Discover 安装 `@oh-summy/connect-lark`，或直接从市场索引 `https://oh-summy.github.io/dsh-nano-market/index.json` 添加。
2. **创建应用**：打开 [飞书开放平台](https://open.feishu.cn/app)，创建自建应用并启用机器人。配置页的「创建应用与权限」弹窗提供最小权限清单和复制按钮。
3. **配置**：填写 App ID 和 App Secret。访问控制默认「跟随应用权限」——谁能私聊机器人由飞书应用的「可用范围」决定，插件不再额外限制，无需填任何 id。需要收紧时才切到「指定人员可用」。完整 Secret 只保存在 DSH 凭据缝，应用配置保存在本机 DSH profile，均不进入 Git；页面仅显示前 5 位 + 掩码。
4. **可选收紧**：在「访问控制」切到「指定人员可用」，用姓名或 open_id 搜索并授权；租户管理员始终可用。工作区可通过路径右侧的目录弹窗选择任意文件夹（不会加入 DSH 工作区列表）；模型和思考强度默认跟随 DSH 新会话。
5. **启用**：插件本身的开关即连接。访问控制由插件的 allowlist 和 `accessMode` 管理；群里固定 @ 机器人触发。
6. **卡片快捷设置的前提**：想用回复卡上的「模型 / 思考强度 / 权限 / 工作区」快捷切换，必须在飞书开发者后台为应用订阅**卡片回传交互回调**（见下方「卡片快捷设置前提」）；不订阅不影响普通对话，只影响卡片内的切换入口。

## 功能

- 飞书私聊 / 群 @ → 流式富卡片回复（Markdown：粗体 / 列表 / 表格 / 代码 / 链接）
- 卡片快捷设置：每轮回复卡底部常驻当前生效状态行 + 「模型 / 思考强度 / 权限 / 工作区」四个入口，点击弹出对应维度的选择卡，选中即生效。这是**会话级设置**（只作用于当前飞书 chat 对应的 DSH 会话，不影响其他 chat 与 DSH 全局配置）；切换工作区 = 新开一段对话（bot 明确提示）；完全权限需二次确认（仅发起人「确认」生效）。**应用前提见「卡片快捷设置前提」**
- 读取 / 识别图片：先做 Content-Length 预检查再流式落盘并限制 20 MiB，再保存附件；`owned-per-chat` 对解析后的实际模型执行视觉 gate，`attach-gui` 交给宿主
- 标题 + 背景色、底部小字、按钮（需要调用方提供原始 CardKit JSON）
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
| `permissionPreset` | `""` | 留空跟随 DSH；可选仅可查看、工作区内修改、完全权限、自动审查 |
| `agentOwnership` | `owned-per-chat` | 默认每个聊天独立 Agent；`attach-gui` 仅高级场景使用 |
| `accessMode` | `app` | 访问模式：`app` 跟随飞书应用的可用范围（默认，不额外限制）；`list` 只允许授权名单与租户管理员 |
| `requireMention` | `true` | 群聊需要 @ 机器人 |
| `senderAllowlist` | `[]` | 私聊用户限制；`restricted` 模式下为空则拒绝所有私聊 |
| `groupAllowlist` | `[]` | 群聊限制；`restricted` 模式下为空则拒绝所有群聊 |
| `openId` | `""` | 你的 open_id；设置后私聊强制只允许该用户（两种模式都生效） |

插件本身的启用开关直接控制连接生命周期。旧 `enabled` 配置字段仅为兼容保留，不再作为第二个开关。

## 卡片快捷设置前提

回复卡上的四个设置入口依赖飞书的**卡片回传交互回调**。该回调**不在「添加事件」列表里**（搜 "card" 搜不到），配置入口如下：

1. 打开 [飞书开发者后台](https://open.feishu.cn/app) → 目标应用 → **开发配置 → 事件与回调**
2. 切到 **「回调配置」页签**（不是「事件订阅」）
3. **订阅方式**确认为「使用长连接接收回调」（插件的传输模式即长连接，无需配置请求地址）
4. 在 **「已订阅的回调」** → 添加 → 选择 **「卡片回传交互回调」（`card.action.trigger`）** → 保存
5. 若后台提示修改需生效：到 **版本管理与发布** 创建并发布一次应用版本

注意：

- 不订阅回调不影响普通对话（收发消息、流式卡片都正常），只影响卡片上的设置入口——点击时会提示「该应用尚未配置卡片回调」。
- 无需配置任何请求地址（长连接模式下回调经 WebSocket 直达插件）；「链接预览」「自定义名片页」等其他回调与本插件无关，按需添加即可。
- 配置变更若要求发布版本，发布后才在所有客户端生效。

> **安全提示**：机器人运行在本机进程内，可执行文件操作。默认 `accessMode: app` 跟随飞书应用的可用范围；收紧到 `list` 后空名单会拒绝所有聊天，请显式授权或设置 `openId`；仅个人私有场景可设 `open`。不要在可被他人私聊的飞书应用上使用 `open`。

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