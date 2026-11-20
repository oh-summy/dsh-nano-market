// 物化/回收单测：软链只创建不覆盖、卸载只撤自有链接、失败互不阻断。
// 用真实 fs + HOME 重定向到临时目录（node --test 每文件独立进程，不影响其他文件）；
// HOME 必须在 import lib 之前设置——物化路径常量在模块加载时求值。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-mat-"));
process.env.HOME = tmpHome;
const { materializeCli, dematerializeCli } = await import("../lib/index.mjs");

const DSH_BIN_LINK = path.join(tmpHome, ".dsh", "bin", "dsh-web");
const NPM_BIN_LINK = path.join(tmpHome, ".npm-global", "bin", "dsh-web");
// lib/index.mjs 里的 cliBinPath() 解析到 <pkg>/bin/dsh-web.mjs（仓库内真实文件）
const REPO_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "dsh-web.mjs");

function fakeCtx() {
  const msgs = [];
  return {
    ctx: { logger: { info: (m) => msgs.push(["info", m]), warn: (m) => msgs.push(["warn", m]) } },
    msgs,
  };
}
const ready = (msgs) => msgs.some(([lv, m]) => lv === "info" && m.includes("命令已就绪"));
const blockedWarn = (msgs) => msgs.some(([lv, m]) => lv === "warn" && m.includes("不动用户文件"));

test("物化：两级软链创建 + 就绪日志，链接链正确", () => {
  const { ctx, msgs } = fakeCtx();
  materializeCli(ctx);
  assert.equal(fs.readlinkSync(DSH_BIN_LINK), REPO_BIN, "一级 → 插件包内 bin");
  assert.equal(fs.readlinkSync(NPM_BIN_LINK), DSH_BIN_LINK, "二级 → 一级");
  assert.ok(ready(msgs));
});

test("物化幂等：重复装载不告警、链接不变", () => {
  const { ctx, msgs } = fakeCtx();
  materializeCli(ctx);
  assert.equal(fs.readlinkSync(DSH_BIN_LINK), REPO_BIN);
  assert.equal(fs.readlinkSync(NPM_BIN_LINK), DSH_BIN_LINK);
  assert.ok(!blockedWarn(msgs), "不应有覆盖告警");
  assert.ok(ready(msgs));
});

test("回收：只撤自有软链，两个都清掉", () => {
  const { ctx } = fakeCtx();
  dematerializeCli(ctx);
  assert.equal(fs.existsSync(DSH_BIN_LINK), false);
  assert.equal(fs.existsSync(NPM_BIN_LINK), false);
});

test("P1-2 回归：一级被外来软链占用 → 不覆盖、不建二级、不报就绪", () => {
  fs.mkdirSync(path.dirname(DSH_BIN_LINK), { recursive: true });
  const foreign = path.join(tmpHome, "foreign-target");
  fs.writeFileSync(foreign, "user data");
  fs.symlinkSync(foreign, DSH_BIN_LINK);
  const { ctx, msgs } = fakeCtx();
  materializeCli(ctx);
  assert.equal(fs.readlinkSync(DSH_BIN_LINK), foreign, "外来软链原样保留");
  assert.equal(fs.existsSync(NPM_BIN_LINK), false, "不再建二级");
  assert.ok(!ready(msgs));
  assert.ok(blockedWarn(msgs));
  // 清场
  fs.unlinkSync(DSH_BIN_LINK);
});

test("P1-2 回归：一级是普通文件 → 不动用户文件、不建二级、不报就绪", () => {
  fs.mkdirSync(path.dirname(DSH_BIN_LINK), { recursive: true });
  fs.writeFileSync(DSH_BIN_LINK, "user file");
  const { ctx, msgs } = fakeCtx();
  materializeCli(ctx);
  assert.equal(fs.readFileSync(DSH_BIN_LINK, "utf8"), "user file", "普通文件未被触碰");
  assert.equal(fs.existsSync(NPM_BIN_LINK), false);
  assert.ok(!ready(msgs));
  assert.ok(blockedWarn(msgs));
  fs.unlinkSync(DSH_BIN_LINK);
});

test("P1-2 回归：二级被外来软链占用 → 一级正常、外来二级保留、不报就绪", () => {
  const { ctx } = fakeCtx();
  materializeCli(ctx); // 此时两级都干净 → 正常创建
  assert.ok(fs.existsSync(DSH_BIN_LINK));
  const foreign = path.join(tmpHome, "foreign-target2");
  fs.writeFileSync(foreign, "user data");
  fs.unlinkSync(NPM_BIN_LINK);
  fs.symlinkSync(foreign, NPM_BIN_LINK);
  const { ctx: ctx2, msgs } = fakeCtx();
  materializeCli(ctx2);
  assert.equal(fs.readlinkSync(NPM_BIN_LINK), foreign, "外来二级不被接管");
  assert.equal(fs.readlinkSync(DSH_BIN_LINK), REPO_BIN, "一级不受影响");
  assert.ok(!ready(msgs));
  // 清理：一级是自有 → 会被撤；外来二级 → 保留
  dematerializeCli(ctx2);
  assert.equal(fs.existsSync(DSH_BIN_LINK), false);
  assert.equal(fs.readlinkSync(NPM_BIN_LINK), foreign, "外来文件绝不被误删");
  fs.unlinkSync(NPM_BIN_LINK);
  fs.unlinkSync(foreign);
});

test("回收：目标本来就不存在 → 不抛错", () => {
  const { ctx } = fakeCtx();
  dematerializeCli(ctx); // 链接已不存在
  assert.equal(fs.existsSync(DSH_BIN_LINK), false);
  assert.equal(fs.existsSync(NPM_BIN_LINK), false);
});
