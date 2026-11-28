// 通知风暴隔离验证（子进程）：用假的 cloudflared 复刻 2026-11-28 事故场景
// （隧道请求被代理重置 → 进程立刻退出），统计插件往飞书推了几条消息。
// 由 test/notify-storm.test.mjs 以子进程方式拉起（HOME 指向临时目录，真机不挨碰）。
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.STORM_HOME;
const PLUGIN = process.env.STORM_PLUGIN;
const WINDOW_MS = Number(process.env.STORM_WINDOW_MS || 12000);

const RUN_DIR = join(HOME, ".remote-control", "run-plugin");
const BIN_DIR = join(HOME, ".remote-control", "bin");
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(RUN_DIR, { recursive: true });

// STORM_MODE=tunnel（默认）：隧道侧失败——复刻事故日志（请求隧道失败 → 立刻退出）
// STORM_MODE=gate：密码门侧失败——隧道常驻，密码门反复退出
const MODE = process.env.STORM_MODE || "tunnel";

writeFileSync(join(BIN_DIR, "cloudflared"), MODE === "tunnel" ? `#!/bin/sh
echo "2026-11-28T15:12:49Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": read tcp 198.18.0.1:64427->198.18.0.130:443: read: connection reset by peer' >&2
exit 1
` : "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(BIN_DIR, "cloudflared"), 0o755);

// 假的 caddy：常驻（假装密码门本身是好的——只测隧道失败这条线）
writeFileSync(join(BIN_DIR, "caddy"), MODE === "gate" ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(BIN_DIR, "caddy"), 0o755);

// 运行时设置：与真机一致（autoStart=true 才会自动拉隧道）
writeFileSync(join(RUN_DIR, "settings.json"), JSON.stringify({
  enabled: true, autoStart: true, autoRestart: true,
  notifyChannel: "dm", notifyAppId: "cli_test", notifyOpenId: "ou_test",
  notifyChatId: "", notifyChatName: "", sessionDays: 7, alias: "测试机",
}, null, 2));

// 拦截飞书投递：token 端点给假 token，消息端点计数
let sent = 0;
const titles = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("tenant_access_token")) {
    return { ok: true, status: 200, json: async () => ({ tenant_access_token: "t" }) };
  }
  if (u.includes("/im/v1/messages")) {
    sent++;
    try {
      const card = JSON.parse(JSON.parse(init.body).content);
      const lines = (card.elements || []).map(e => e.text && e.text.content).filter(Boolean);
      titles.push(card.header.title.content + " || " + lines.join(" / "));
    } catch { titles.push("?"); }
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { apply } = await import(PLUGIN);
const secrets = new Map([["DSH_REMOTE_APP_SECRET", "secret"]]);
let disposer = null;
const ctx = {
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  credentials: {
    resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref) } : null),
    set: async (ref, value) => { secrets.set(ref, value); },
  },
  effect: (fn) => { disposer = fn(); },
};

apply(ctx, {});

setTimeout(() => {
  console.log(JSON.stringify({ notifications: sent, titles }));
  try { if (disposer) disposer(); } catch { /* ignore */ }
  process.exit(0);
}, WINDOW_MS);
