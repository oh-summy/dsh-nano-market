// 通知风暴回归测试（事故 2026-11-28）：
// 复刻现场——cloudflared 请求隧道时被本机代理重置、进程立刻退出——
// 断言插件只推一条「已断开」，而不是每 5 秒一条；
// 并且绝不能把 api.trycloudflare.com（API 端点）当成隧道地址推给主人。
// 整个场景在临时 HOME + 假二进制里跑，真机不挨碰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const PLUGIN = join(pkgDir, "lib", "index.mjs");
const HARNESS = join(here, "fixtures", "storm-harness.mjs");
const WINDOW_MS = 12_000; // 旧实现在这个窗口里会推 3 条；修复后固定 1 条

test("通知风暴：隧道连续失败时只推一条，且绝不把 API 端点当隧道地址", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-remote-storm-"));
  try {
    const res = runHarness(home);
    const out = JSON.parse(res);
    const cards = out.titles || [];

    // ① 只推一条（旧实现同一窗口推 3-4 条：每 5 秒一张「已断开」）
    assert.equal(out.notifications, 1, "持续故障只应推一条通知，实际 " + out.notifications + " 条：" + JSON.stringify(cards));

    // ② 这一条必须是「已断开」，不能是「已开启」
    assert.match(cards[0] || "", /远程访问已断开/, "首次失败应推「已断开」：" + (cards[0] || ""));

    // ③ 绝不出现 API 端点当隧道地址（旧实现会推「已开启 · 访问地址 https://api.trycloudflare.com」）。
    //    注意：失败原因里提到 api.trycloudflare.com 是**正确的诊断信息**，只禁「访问地址」槽位。
    for (const c of cards) {
      assert.doesNotMatch(c, /访问地址[^\n]*api\.trycloudflare\.com/, "不得把 API 端点当隧道地址推送：" + c);
    }

    // ④ 退避生效：5s 重试最多出现一次（后续是 10s / 20s / 40s / 60s）
    const events = readEvents(home);
    const fiveSecondRetries = events.filter((e) => /cloudflared 退出，5s 后自动重拉/.test(e.detail)).length;
    assert.ok(fiveSecondRetries <= 1, "固定 5s 重试最多一次（应指数退避），实际 " + fiveSecondRetries + " 次");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("通知风暴：密码门反复退出同样只推一条", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-remote-gate-"));
  try {
    const out = JSON.parse(runHarness(home, "gate"));
    assert.equal(out.notifications, 1, "密码门持续故障只应推一条通知，实际 " + out.notifications + " 条：" + JSON.stringify(out.titles));
    assert.match(out.titles[0] || "", /远程访问已断开/, "应推「已断开」：" + (out.titles[0] || ""));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function runHarness(home, mode = "tunnel") {
  const res = spawnSync(process.execPath, [HARNESS], {
    encoding: "utf8",
    timeout: WINDOW_MS + 30_000,
    env: {
      ...process.env,
      HOME: home,
      STORM_HOME: home,
      STORM_PLUGIN: PLUGIN,
      STORM_MODE: mode,
      STORM_WINDOW_MS: String(WINDOW_MS),
    },
  });
  assert.equal(res.status, 0, "harness 应正常退出：" + (res.stderr || "").slice(0, 400));
  const line = (res.stdout || "").trim().split("\n").filter(Boolean).pop();
  return line;
}

function readEvents(home) {
  const eventsPath = join(home, ".remote-control", "run-plugin", "events.json");
  assert.ok(existsSync(eventsPath), "应写出事件日志");
  return JSON.parse(readFileSync(eventsPath, "utf8"));
}
