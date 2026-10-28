# @oh-summy/dsh-remote

Secure remote access to **DeepSeek Harness (DSH)** from anywhere — **Cloudflare quick tunnel → password gate → DSH web profile**, with **Feishu (Lark) notifications** pushed to your phone whenever the entry URL or service state changes.

## Quick Start

1. **安装**：从市场 Discover 页或直接 `dsh plugin --profile web add @oh-summy/dsh-remote`
2. **启用**：Plugins 页找到 dsh-remote，打开 `enabled` 开关，重启宿主
3. **配置**：在管理页填入飞书通知凭据（可选，用于地址变更推送）
4. **验证**：访问 Cloudflare 隧道地址，输入密码门进入 DSH

> **注意**：旧版独立脚本网关在旧仓库 oh-summy/dsh-remote-control。两者不要同时启用——端口 4080 冲突时插件会明确报错。

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

## Enable

The bundle ships disabled (`cordis.patch.yml`: `enabled: false`). Flip it to `true` and restart the host — the plugin starts the chain and opens its management page inside DSH (Settings → Built-in plugins → 远程访问), showing the entry URL, the password gate, and the notification configuration.

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

## Requirements

- macOS (x86_64 / arm64) or Linux (x86_64 / arm64); `cloudflared` + `caddy` must be installed beforehand — the plugin probes `~/.remote-control/bin/` then `PATH` at startup, and missing binaries are flagged by the management page's environment check.
- DSH web profile (engines.dsh: `>=0.2.1-rc.2 || >=0.2.2-0`). Windows is not officially supported — PRs welcome with real test evidence.

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

