// 故障策略单测（事故 2026-11-28）：
//   ① 隧道地址解析——失败日志里的 api.trycloudflare.com 不是隧道（打不开的根因）；
//   ② 失败原因翻译——代理/fake-ip 劫持要能看出来；
//   ③ 重拉退避 + down 通知闸门——别再每 5 秒刷一条飞书；
//   ④ 孤儿进程识别——DSH 被杀后残留的 caddy/cloudflared 要能收回来。
// 直接 import 构建产物 lib/index.mjs——与运行时同一份实现。
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTunnelUrl,
  isTunnelLabel,
  describeTunnelFailure,
  respawnDelayMs,
  shouldNotifyDown,
  findOwnedPids,
} from "../lib/index.mjs";

// ---------- ① 隧道地址解析 ----------

test("extractTunnelUrl：事故日志里的 api.trycloudflare.com 不是隧道地址", () => {
  // 事故原文（2026-11-28 23:12）：旧正则把它当成隧道地址推给了飞书
  const log = [
    "2026-11-28T15:12:49Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.",
    "2026-11-28T15:12:49Z INF Requesting new quick Tunnel on trycloudflare.com...",
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": read tcp 198.18.0.1:64427->198.18.0.130:443: read: connection reset by peer',
  ].join("\n");
  assert.equal(extractTunnelUrl(log), "");
});

test("extractTunnelUrl：真正的隧道地址照常抓得到", () => {
  const log = [
    "2026-11-28T15:12:49Z INF Thank you for trying Cloudflare Tunnel.",
    "2026-11-28T15:12:52Z INF +-----------------------------------------+",
    "2026-11-28T15:12:52Z INF | Your quick Tunnel has been created!  |",
    "2026-11-28T15:12:52Z INF |  https://witty-frost-rice.trycloudflare.com  |",
    "2026-11-28T15:12:52Z INF +-----------------------------------------+",
  ].join("\n");
  assert.equal(extractTunnelUrl(log), "https://witty-frost-rice.trycloudflare.com");
});

test("extractTunnelUrl：失败行与成功行混在一起时只认成功行", () => {
  const log = [
    'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": connection reset by peer',
    "2026-11-28T15:12:52Z INF |  https://gifted-lemons-happen.trycloudflare.com  |",
  ].join("\n");
  assert.equal(extractTunnelUrl(log), "https://gifted-lemons-happen.trycloudflare.com");
});

test("extractTunnelUrl：空日志 → 空串（不得回退到 api 端点）", () => {
  assert.equal(extractTunnelUrl(""), "");
  assert.equal(extractTunnelUrl("   \n  \n"), "");
});

test("isTunnelLabel：API 端点与普通词都不算隧道 ID", () => {
  assert.equal(isTunnelLabel("api"), false);
  assert.equal(isTunnelLabel("www"), false);
  assert.equal(isTunnelLabel(""), false);
  assert.equal(isTunnelLabel("abc-def"), true);
  assert.equal(isTunnelLabel("abc123"), true);
});

// ---------- ② 失败原因翻译 ----------

test("describeTunnelFailure：连接被重置要能看出来（代理劫持的典型症状）", () => {
  const log = 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": read tcp 198.18.0.1:64427->198.18.0.130:443: read: connection reset by peer';
  const reason = describeTunnelFailure(log);
  assert.match(reason, /连接被重置/);
  assert.match(reason, /connection reset by peer/);
});

test("describeTunnelFailure：DNS 失败 / 超时 / 拒绝分别归类", () => {
  assert.match(describeTunnelFailure('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host'), /DNS 解析失败/);
  assert.match(describeTunnelFailure("failed to request quick Tunnel: i/o timeout"), /连接超时/);
  assert.match(describeTunnelFailure("failed to request quick Tunnel: dial tcp 127.0.0.1:7897: connect: connection refused"), /连接被拒绝/);
});

test("describeTunnelFailure：日志里没有报错 → 空串（不编原因）", () => {
  assert.equal(describeTunnelFailure("INF Starting tunnel"), "");
  assert.equal(describeTunnelFailure(""), "");
});

// ---------- ③ 退避 + 通知闸门 ----------

test("respawnDelayMs：指数退避并封顶 60s", () => {
  assert.equal(respawnDelayMs(0), 5_000);
  assert.equal(respawnDelayMs(1), 10_000);
  assert.equal(respawnDelayMs(2), 20_000);
  assert.equal(respawnDelayMs(3), 40_000);
  assert.equal(respawnDelayMs(4), 60_000);
  assert.equal(respawnDelayMs(20), 60_000);
  assert.equal(respawnDelayMs(-1), 5_000);
});

test("shouldNotifyDown：首次故障必发；10 分钟内不再发；过期后允许提醒", () => {
  const t0 = 1_000_000;
  assert.equal(shouldNotifyDown(0, t0), true); // 从未通知过 → 首次故障要发
  assert.equal(shouldNotifyDown(t0, t0 + 1_000), false);
  assert.equal(shouldNotifyDown(t0, t0 + 9 * 60_000), false);
  assert.equal(shouldNotifyDown(t0, t0 + 10 * 60_000), true);
});

// ---------- ④ 孤儿进程识别 ----------

test("findOwnedPids：只认带本插件特征的进程", () => {
  const ps = [
    "  123 /usr/local/bin/node /Users/rocky/.npm-global/bin/dsh web",
    "  456 /Users/rocky/.remote-control/bin/caddy run --config /Users/rocky/.remote-control/run-plugin/Caddyfile",
    "  789 /Users/rocky/.remote-control/bin/cloudflared tunnel --url http://127.0.0.1:4080 --no-autoupdate --protocol http2",
    "  999 /usr/bin/some-other-daemon",
  ].join("\n");
  const pids = findOwnedPids(ps, ["/Users/rocky/.remote-control/run-plugin/Caddyfile", "http://127.0.0.1:4080"]);
  assert.deepEqual(pids, [456, 789]);
});

test("findOwnedPids：没有任何特征 → 空（绝不误杀外人）", () => {
  const ps = "  123 /usr/local/bin/node /Users/rocky/.npm-global/bin/dsh web\n  999 /usr/bin/some-other-daemon";
  assert.deepEqual(findOwnedPids(ps, ["/nope/Caddyfile"]), []);
  assert.deepEqual(findOwnedPids("", ["/nope"]), []);
});
