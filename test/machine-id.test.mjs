// 机器身份格式化单测（审查 P1-8）：maskIp 掩码规则 + formatMachineLine 组装规则。
// 直接 import 构建产物 lib/index.mjs——与运行时同一份实现。
import test from "node:test";
import assert from "node:assert/strict";
import { maskIp, formatMachineLine, applyCapturedUrl } from "../lib/index.mjs";

test("maskIp：IPv4 只留前两段", () => {
  assert.equal(maskIp("192.168.5.4"), "192.168.***.***");
  assert.equal(maskIp("10.0.0.1"), "10.0.***.***");
});

test("maskIp：非四段/空值原样返回（IPv6 或无网环境不做错误掩码）", () => {
  assert.equal(maskIp(""), "");
  assert.equal(maskIp("fe80::1"), "fe80::1");
  assert.equal(maskIp("192.168"), "192.168");
});

test("formatMachineLine：别名打头，无别名退化为 主机名 · IP", () => {
  assert.equal(formatMachineLine("个人电脑", "xiaoxin-2.local", "192.168.5.4"), "个人电脑 · xiaoxin-2.local · 192.168.***.***");
  assert.equal(formatMachineLine("", "xiaoxin-2.local", "192.168.5.4"), "xiaoxin-2.local · 192.168.***.***");
  assert.equal(formatMachineLine("  办公室  ", "h.local", "10.0.0.1"), "办公室 · h.local · 10.0.***.***");
});

test("formatMachineLine：无 IP（无网环境）时不留悬挂分隔符", () => {
  assert.equal(formatMachineLine("个人电脑", "h.local", ""), "个人电脑 · h.local");
  assert.equal(formatMachineLine(undefined, "h.local", ""), "h.local");
});

test("formatMachineLine：别名两端空白被裁剪", () => {
  assert.equal(formatMachineLine("  ", "h.local", "10.0.0.1"), "h.local · 10.0.***.***");
});

test("applyCapturedUrl：首次 spawn 捕获 URL → currentUrl 恢复且推送（审查三轮 P1-1 用例 1）", () => {
  const r = applyCapturedUrl("https://a.trycloudflare.com", "");
  assert.equal(r.currentUrl, "https://a.trycloudflare.com");
  assert.equal(r.announce, true);
  assert.equal(r.changed, false); // 首次 = started
});

test("applyCapturedUrl：第二次 spawn 捕获相同 URL → currentUrl 仍有值但不重复推送（用例 2）", () => {
  const r = applyCapturedUrl("https://a.trycloudflare.com", "https://a.trycloudflare.com");
  assert.equal(r.currentUrl, "https://a.trycloudflare.com");
  assert.equal(r.announce, false); // 同 URL 不重复推送
  assert.equal(r.changed, false);
});

test("applyCapturedUrl：URL 变化 → currentUrl 恢复且按 changed 推送", () => {
  const r = applyCapturedUrl("https://b.trycloudflare.com", "https://a.trycloudflare.com");
  assert.equal(r.currentUrl, "https://b.trycloudflare.com");
  assert.equal(r.announce, true);
  assert.equal(r.changed, true);
});
