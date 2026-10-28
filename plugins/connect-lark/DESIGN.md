# connect-lark 架构设计

## 目标

飞书 / Lark 长连接桥接：飞书消息 → 本机 DSH agent → 富卡片回复。

## 核心决策

### 1. in-process cordis 插件

插件运行在 DSH 宿主进程内，直接使用 `ctx.agents` / `ctx.llm` / `ctx.attachments` / `ctx.credentials`。不 spawn 外部 CLI，无子进程孤儿风险。

### 2. @larksuite/channel（不是 lark-cli）

lark-cli 也是真 WebSocket 长连接，但无托管流式抽象。选 channel 的理由：进程内调用 + 类型安全 + 托管能力（规范化 / 去重 / per-chat queue / 媒体）+ 与 Cordis disposer 的生命周期对齐。

channel 仍是 0.x，精确 pin 版本（不用 `^`）、锁依赖、显式设置 REST 超时。

### 3. 两种 agent 所有权

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `attach-gui` | 复用宿主已有 agent（`ctx.agents.get(attachSessionId)`） | 共享 GUI agent，需要显式指定目标 session |
| `owned-per-chat` | 插件自建 agent（`ctx.agents.create({sessionId, meta:{cwd}, agentOptions:{provider,model}})`），运行结束 `handle.dispose()` | 每个 chat 独立 agent，需要 provider/model/cwd |

Lark 回调里没有可直接读取的「当前 agent」，必须显式指定目标。

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

### 6. 白名单 fail-closed

`senderAllowlist` 和 `groupAllowlist` 都必须配置（非空）才能放行消息。任何一个为空 = 该维度拒绝全部（fail-closed）。

### 7. 资源管理

- disposer 断连 + dispose owned agents + 清 slots + unsub events
- 所有 timer 登记进 disposer
- `channel.connect()` 失败时 throw，不静默

## 结构

    plugins/connect-lark/
      package.json        # 依赖、scripts、dsh.bundle.patch
      cordis.patch.yml    # bundle 配置
      LICENSE             # MIT
      src/index.ts        # apply(ctx): channel + 消息处理 + agent 驱动 + disposer
      src/cards.ts        # 卡片构建（richCard + streamMarkdown）
      src/images.ts       # 图片处理（admitImage + buildImageContent + downloadInboundImage）
      src/run.ts          # RunManager：状态机 + 队列 + 取消 + dispose
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
- 热更新字段决策（appId / provider / model 改了要不要重连）
- engines.dsh 最低版本验证（本地 rc.4，声明 rc.2 未验证）
- zod advisory override 决定（dsh-llm 传递引入 zod 4.4.3，有 high advisory）
- dsh-remote 添加测试（当前无 test/ 目录）