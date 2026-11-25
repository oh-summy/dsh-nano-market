// 会话令牌单测（issue #47）：签名/过期/篡改/格式。
// 直接 import 构建产物 lib/index.mjs——与运行时同一份实现。
import test from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession } from "../lib/index.mjs";

const SECRET = "test-secret-0123456789abcdef";
const NOW = 1_700_000_000_000;

test("签发→校验：未过期通过", () => {
  const token = signSession(NOW + 86_400_000, SECRET);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(verifySession(token, SECRET, NOW), true);
});

test("过期：exp 在过去 → 校验失败（服务端过期，审查 #47 核心）", () => {
  const token = signSession(NOW - 1, SECRET);
  assert.equal(verifySession(token, SECRET, NOW), false);
});

test("篡改签名 → 校验失败", () => {
  const token = signSession(NOW + 86_400_000, SECRET);
  const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
  assert.equal(verifySession(forged, SECRET, NOW), false);
});

test("换密钥（重置密码轮换 sessionSecret）→ 旧令牌失效", () => {
  const token = signSession(NOW + 86_400_000, SECRET);
  assert.equal(verifySession(token, SECRET + "rotated", NOW), false);
});

test("格式非法：静态旧令牌/垃圾串 → 校验失败（升级后旧会话一次性失效）", () => {
  assert.equal(verifySession("0123456789abcdef0123456789abcdef", SECRET, NOW), false);
  assert.equal(verifySession("garbage", SECRET, NOW), false);
  assert.equal(verifySession("v1.onlypayload", SECRET, NOW), false);
});
