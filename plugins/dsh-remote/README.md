# @oh-summy/dsh-remote

Secure remote access to **DeepSeek Harness (DSH)** from anywhere — **Cloudflare quick tunnel → password gate → DSH web profile**, with **Feishu (Lark) notifications** pushed to your phone whenever the entry URL or service state changes.

## Quick Start

1. **安装**：从市场 Discover 页或直接 `dsh plugin --profile web add @oh-summy/dsh-remote`
2. **启用**：Plugins 页找到 dsh-remote，打开 `enabled` 开关，重启宿主
3. **配置**：在 Plugins → Nano Market → dsh-remote → 「配置」打开详情页，里面就是完整的远程访问管理面（隧道地址、密码门、飞书通知）
4. **验证**：访问 Cloudflare 隧道地址，输入密码门进入 DSH

> **注意**：旧版独立脚本网关（仓库 oh-summy/dsh-remote-control）已退役——远程访问的唯一实现与控制面是本插件，终端入口 `dsh-web` 命令现在由插件自带（见下文「dsh-web 命令」）。若 4080 仍被旧网关占用，插件会明确报错而不是抢端口。

## 致谢与参考

本插件是 oh-summy 原创实现，设计参考了以下项目：

| 类型 | 项目 | 许可 | 参考内容 |
|---|---|---|---|
| A 代码依赖 | @deepseek-ai/dsh-credentials | MIT | DSH 凭据缝 |
| A 代码依赖 | zod | MIT | 配置校验 |

## Install

From DSH's Discover tab (this market), or directly:

```sh
dsh plugin --profile web add @oh-summy/dsh-remote
```

## 机器身份（v0.5.0 起）

多台机器都开远程访问时，推送与登录页据此分辨是哪一台：

- **卡片标题**：所有飞书推送标题形如 `远程访问已开启 · <别名> · <主机名> · <IP前两段>.***.***`（别名留空则只有主机名 · IP 掩码）。
- **登录页**：密码门标题下显示同一行机器身份（远程用户输密码前先确认连的是哪台机器）。
- **别名**：在插件详情页管理面的「机器别名」填写（≤64 字符），存 settings.json，跨重启与插件更新保留。
- **公开范围**：登录页为未鉴权页面，可见别名/主机名/IP 掩码（前两段）；完整内网 IP 仅在管理面 state 接口（鉴权后）出现。

## Enable

The bundle ships disabled (`cordis.patch.yml`: `enabled: false`). Flip it to `true` and restart the host — the plugin starts the chain and its management page appears on the plugin's own detail page (Plugins → Nano Market → dsh-remote → 配置), showing the entry URL, the password gate, and the notification configuration.

> v0.3.0 起，管理页从 Plugins 页的独立页签迁到插件详情页；页签由 @oh-summy/nano-market 提供的「Nano Market」市场页承担。

## dsh-web 命令（v0.4.0 起，随插件走）

装好本插件且 entry 打开后，机器上就有 `dsh-web` 命令——插件装载时把包内 `bin/dsh-web.mjs` 以**软链**物化到 `~/.dsh/bin/dsh-web`，再软链 `~/.npm-global/bin/dsh-web`（该目录已在 PATH 内）。

> **软链生命周期（0.5.0 起，规范定版）**：软链只在**装载**时创建（已存在且目标一致则跳过；绝不覆盖用户自建文件）；**停用/卸载一律不删除**——普通 stop/disposer 无法安全区分「本插件创建的软链」与用户自建文件，而悬空软链天然失效（命令不存在），无副作用。卸载后软链**保留为悬空状态**（宿主 `dsh plugin remove` 与插件自身都不删除）；如需清理，手动删除 `~/.dsh/bin/dsh-web` 与 `~/.npm-global/bin/dsh-web` 即可。

| 命令 | 行为 |
|---|---|
| `dsh-web` | **= start**：后台拉起 DSH（detached + unref，终端可关）→ 起隧道 → 打印 URL + 访问密码 + 速查表；幂等（已在跑时不重复拉起） |
| `dsh-web help` | 只打印命令速查表 |
| `dsh-web stop` | 停隧道（本机 API toggle）+ 停 DSH 进程（按 3080 端口属主核对后终止，非 DSH 拒绝）；装了开机自启 agent 的机器会先 `bootout` 卸载 agent，防止 KeepAlive 复活 |
| `dsh-web restart` | stop → start |
| `dsh-web status` | DSH 进程 / 插件装载 / 隧道 / 通知通道 / 开机自启 agent 在不在 |
| `dsh-web url` | 当前公网入口 URL |
| `dsh-web password` | 访问密码明文（仅本机打印） |
| `dsh-web logs [caddy\|cloudflared\|access\|dsh]` | 尾部日志（缺省 `cloudflared`） |

### 闸门语义：插件是唯一入口（三态探测，顺序不可调换）

| 插件状态 | 命令 | 行为 |
|---|---|---|
| 未安装（profile 里没有插件包） | 不该存在 | 报「插件未安装：`dsh plugin --profile web add @oh-summy/dsh-remote`」并退出，**不产生任何副作用进程** |
| 已安装未打开（profile entry `enabled` 非 true） | 不该存在 | 报「插件未打开：Plugins → Nano Market → dsh-remote → 配置 → 打开 enabled」并退出，**不产生任何副作用进程** |
| 已打开、DSH 没跑 | 存在 | detached 后台拉起 DSH → 等插件 API 就绪 → 起隧道 → 打印 URL + 密码 |
| 已打开、DSH 在跑 | 存在 | 幂等：只打印 URL + 密码 |

判定依据（全部本机级检查，CLI 不依赖宿主）：① 插件包在不在（`~/.dsh/profiles/web/node_modules/@oh-summy/dsh-remote`）；② profile `cordis.patch.yml` 中 `- id: dsh-remote` 块的 `enabled`（entry 级优先，config 级兜底）；③ 插件本机 API `127.0.0.1:9091/rc-api/state`。

**两个开关不要混**：插件装载开关（profile entry `enabled`）决定命令是否存在；隧道运行时开关（插件 settings 的 `enabled`/`autoStart`）决定隧道在不在——`start` 发现隧道没开会经本机 API 自动打开。

### PATH 说明

- 首选落点 `~/.npm-global/bin/dsh-web`（`dsh` 本身就在那儿）；该目录不可写，或同名路径已存在普通文件/指向别处的软链时，插件**只创建、绝不覆盖**，跳过并告警（日志提示「把 `~/.dsh/bin` 加入 PATH」）；两级链接都就绪才打「命令已就绪」。
- 物化是软链不是拷贝：插件卸载后软链悬空，命令随之消失；不会留下「能敲但啥也干不了」的僵尸命令。
- 端口硬约束：整条链路写死 DSH 默认端口 **3080**（插件 Caddy 上游 `UPSTREAM_HOST`），改端口会打断链路。
- **launchd 协同**（装了开机自启 agent 的 macOS）：DSH 的启停只归一方管理，绝不双实例——`start` 在 DSH 未运行时优先 `bootstrap` 重新装载 agent（由 launchd 拉起）；`stop` 停隧道后 `bootout` 卸载 agent（否则 KeepAlive 会立刻复活 DSH，「已停止」就是假的）；无 agent 的机器由 CLI 直接 detached 拉起。

## How it works

```
Browser ──HTTPS──▶ Cloudflare edge (Quick Tunnel: https://<random>.trycloudflare.com)
                        │  outbound-only connection, no inbound ports opened
                        ▼
                 cloudflared ──▶ password gate (signed session cookie)
                        │  http://127.0.0.1:3080
                        ▼
                 DSH web profile (loopback only, zero modification)
```

- **No inbound ports** — the machine only makes outbound connections through the tunnel.
- **Password gate in front of DSH** — login page + signed session cookie (7 days), per-IP lockout after 5 failed attempts. DSH itself stays untouched.
- **Feishu notifications are a necessity, not a nice-to-have** — Quick Tunnel assigns a new random URL on every start; without a push channel you lose the entry. Every start / URL change / failure / recovery pushes a card message.
- **Survives DSH upgrades** — the chain only talks HTTP to 127.0.0.1:3080; no DSH internal APIs.

## Notification setup

Credentials never land in configuration files — they go through DSH's credential seam (`~/.dsh/.credentials.yaml`), and the page shows masked values only.

- **Primary channel (bot DM):** your Feishu open id (`ou_...`). Requires [`lark-cli`](https://github.com/larksuite/cli) installed and configured; the app bot needs IM permission and must be able to DM you.
- **Fallback channel:** group custom-bot webhook — works without lark-cli. If both are set, DM is used and webhook only on failure.

### 通知节奏（v0.5.2 起，不再刷屏）

一次故障 = **两条**消息，中间绝不刷屏：

| 时刻 | 推送 | 内容 |
|---|---|---|
| 隧道/密码门进程第一次退出 | 「远程访问已断开」 | 失败原因 + 连续失败次数 + 重试间隔说明 |
| 故障持续中 | **不推** | 只记进事件日志；10 分钟后最多再提醒一次 |
| 隧道恢复且稳定 30s | 「远程访问已恢复」 | 新地址 + 访问密码 |

- 重拉采用指数退避：5s → 10s → 20s → 40s → 60s（封顶），网络不通时不会每 5 秒烧一次隧道请求。
- 「远程访问已开启 / 访问地址已变化」只在**拿到真实隧道地址**时推——地址取自 cloudflared 成功日志，
  绝不会把 `api.trycloudflare.com`（Cloudflare 的 API 端点）误当成隧道地址推给你。
- 投递本身带重试（4 次，约 30s）：一次网络抖动不该让你收不到地址。

### 排障：链接打不开 / 收不到消息

插件详情页顶部的**红色横幅**直接写着最近一次失败原因，不用翻日志：

- **「连接被重置」/ 报文里出现 `198.18.x.x`** —— 本机代理（Clash Verge 等）的 fake-ip / TUN 模式把
  Cloudflare 的域名劫持了。关掉 TUN 模式，或把 `api.trycloudflare.com` 加进直连规则。
- **「DNS 解析失败」** —— 同上，先查 DNS。
- **「本机代理端口拒绝连接」** —— 代理软件没开，但环境变量还指着它的端口；DSH 会读取
  `http_proxy` / `https_proxy`，启动前 `unset` 掉或把代理开起来。
- **「DSH 上游未就绪（127.0.0.1:3080 无响应）」** —— DSH 的 web 还没起来，等几秒刷新；
  这个提示取代了旧的「弹回登录页 → 输密码 → 再弹回」死循环。

## Requirements

- macOS (x86_64 / arm64) or Linux (x86_64 / arm64); `cloudflared` + `caddy` must be installed beforehand — the plugin probes `~/.remote-control/bin/` then `PATH` at startup, and missing binaries are flagged by the management page's environment check.
- DSH web profile (engines.dsh: `>=0.2.1-rc.4 || >=0.2.2-0`). Windows is not officially supported — PRs welcome with real test evidence.

## Security notes

- DSH keeps binding to `127.0.0.1` only; the only public surface is the Cloudflare edge behind the password gate.
- Password: 128-bit random, stored locally with `600` permissions; failed logins lock the source IP for 5 minutes (HTTP 429).
- Session cookie is `HttpOnly` + `SameSite=Lax`, valid 7 days.
- Runtime data (password, token, logs) lives in `~/.remote-control/` with `600` permissions and never enters git.

## Development

```sh
npm install && npm run build   # tsc --noEmit + tsdown (lib/) + client bundle (lib/client.js)
npm run typecheck              # tsc --noEmit only
```

Layout: `src/index.ts` (host plugin), `client-src/client.js` (management page source), `cordis.patch.yml` (bundle patch). Built artifacts in `lib/` are committed so the `pkg/dsh-remote` mirror branch (what the market installs) needs no build step.

## License

MIT — see [LICENSE](../LICENSE) at the repo root.

