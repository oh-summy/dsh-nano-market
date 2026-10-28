# connect-lark 架构设计

## 目标

飞书 / Lark 长连接桥接：飞书消息 → 本机 DSH agent → 富卡片回复。

## 核心决策

### 1. in-process cordis 插件

插件运行在 DSH 宿主进程内，直接使用 `ctx.agents` / `ctx.llm` / `ctx.attachments` / `ctx.credentials`。不 spawn 外部 CLI，无子进程孤儿风险。

### 2. @larksuite/channel（不是 lark-cli）

lark-cli 也是真 WebSocket 长连接，但无托管流式抽象。选 channel 的理由：进程内调用 + 类型安全 + 托管能力（规范化 / 去重 / per-chat queue / 媒体）+ 与 Cordis disposer 的生命周期对齐。

channel 仍是 0.x，精确 pin 版本（不用 `^`）、锁依赖、显式设置 REST 超时。

### 3. Agent、工作区与模型默认值

默认 `owned-per-chat`：每个飞书聊天拥有独立 Agent 和 Session，工作区来自 `defaultPath`，无需用户填写 Session ID。`attach-gui` 仅作为高级兼容模式保留。

`provider`、`model`、`reasoningEffort` 全部可选；留空时不传 `agentOptions`，由 DSH 当前模型和思考强度继承。需要覆盖时才传入对应字段。

普通用户只需 App ID 与 App Secret 凭据引用，其他配置均可使用默认值。

### 4. 流式卡片回复

- 纯 Markdown：`channel.stream(to, { markdown })` — SDK 托管 CardKit
- 富卡片（标题色 / footer / 按钮）：调用方提供原始 CardKit JSON
- 回复在 turn 结束后一次性发送（`chan.send`），非逐字流式

### 5. 图片处理

下载 → attachment admission → 视觉能力 gate → 否则诚实汇报。

三层 gate（照 dsh-acp `assertImageRoute`）：
1. `await ctx.llm.resolveModelInfo(provider, model, signal)` — 必须 await
2. `inputModalities === undefined` 检查 — 不能裸 `.includes("image")`
3. `unknown` 按不支持处理 — 不依赖模型抛错（dsh-llm 会替换成占位文本）

### 6. 默认放行，按聊天类型可选限制

飞书应用自身的使用权限是默认边界。`senderAllowlist` 和 `groupAllowlist` 仅作为高级兼容字段，主界面不暴露。群聊固定要求 @ 机器人，不提供关闭入口。

### 7. 资源管理

- disposer 断连 + dispose owned agents + 清 slots + unsub events
- 所有 timer 登记进 disposer
- `channel.connect()` 失败时 throw，不静默

### 8. 原生配置 UI

第三方插件仅导出 `Config` 不会自动在详情页出现表单。浏览器端还必须注册 `plugins.bundle.config`，key 为 `@oh-summy/connect-lark`，并通过 `configForms.get("connect-lark")` 读取和保存 volatile 配置。

配置页使用 DSH 原生 `SettingsFormModel` / `SettingsForm`，视觉与交互按「连接飞书 → 工作区与模型」组织。国内飞书与海外 Lark 使用分段切换。路径右侧的目录弹窗只选择插件工作目录，不调用 `workspaces.create()`，因此不会加入 DSH 工作区列表；模型从 `modelCatalog()` 读取并使用 DSH 风格搜索弹窗，思考强度随模型提供。应用创建和权限说明放在独立弹窗。完整 App Secret 只保存在 DSH 凭据缝，profile 仅保留前 5 位预览，页面默认显示前 5 位 + 掩码。触发方式不在设置页暴露。

插件自身的 Cordis 开关是唯一连接开关，旧 `enabled` 配置不再作为第二个开关。保存触发 `loader/volatile-update` 后，插件按代际序列清理旧连接和 RunManager、重新读取 volatile 配置，再按新配置启动。

## 结构

    plugins/connect-lark/
      package.json        # 依赖、scripts、dsh.bundle.patch
      cordis.patch.yml    # bundle 配置
      LICENSE             # MIT
      src/index.ts        # apply(ctx): channel + 消息处理 + agent 驱动 + disposer
      src/cards.ts        # 卡片构建（richCard + streamMarkdown）
      src/images.ts       # 图片处理（admitImage + buildImageContent + downloadInboundImage）
      src/run.ts          # RunManager：状态机 + 队列 + 取消 + dispose
      client-src/client.js # DSH 原生配置表单（plugins.bundle.config）
      scripts/build-client.mjs # 浏览器模块打包
      test/               # 插件级测试

## 依赖

| 包 | 版本 | 用途 |
|---|---|---|
| @larksuite/channel | 0.7.1 (精确 pin) | 飞书长连接 + 流式卡片 |
| @larksuiteoapi/node-sdk | 1.73.1 (精确 pin) | 备用低层 SDK |
| @deepseek-ai/schemastery | 3.18.5 (精确 pin) | 配置 schema |
| @deepseek-ai/cosmokit | 1.8.6 (精确 pin) | isVolatile 判定 |
| @deepseek-ai/dsh-llm | 0.2.1-rc.4 | createUserMessage |
| @deepseek-ai/dsh-credentials | 0.2.1-rc.4 | 凭据缝 |

## 待办

- CoT spike（cot-discard / cot-visible 需要 message_cot API 实测）
- engines.dsh 最低版本验证（本地 rc.4，声明 rc.2 未验证）
- zod advisory override 决定（dsh-llm 传递引入 zod 4.4.3，有 high advisory）
- dsh-remote 添加测试（当前无 test/ 目录）