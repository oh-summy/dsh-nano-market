// 物化/回收单测：软链只创建不覆盖、自有悬空链接管、卸载只撤自有链接、失败互不阻断。
// 每个用例独立的临时 HOME + query 破缓存重载 lib（物化路径常量在模块加载时求值）；
// 断言一律用 lstatSync（existsSync 对悬空软链返回 false，会制造假阳性）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "dsh-web.mjs");
let caseSeq = 0;

async function freshCase() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-mat-"));
  process.env.HOME = home;
  const mod = await import("../lib/index.mjs?case=" + (++caseSeq)); // query 使每次拿到全新模块实例
  return { mod, home };
}

const dshLink = (home) => path.join(home, ".dsh", "bin", "dsh-web");
const npmLink = (home) => path.join(home, ".npm-global", "bin", "dsh-web");

function fakeCtx() {
  const msgs = [];
  return {
    ctx: { logger: { info: (m) => msgs.push(["info", m]), warn: (m) => msgs.push(["warn", m]) } },
    msgs,
  };
}
const ready = (msgs) => msgs.some(([lv, m]) => lv === "info" && m.includes("命令已就绪"));
const blockedWarn = (msgs) => msgs.some(([lv, m]) => lv === "warn" && m.includes("不动用户文件"));
const existsAny = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } }; // 悬空链也算存在

test("物化：两级软链创建 + 就绪日志，链接链正确", async () => {
  const { mod, home } = await freshCase();
  const { ctx, msgs } = fakeCtx();
  mod.materializeCli(ctx);
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "一级 → 插件包内 bin");
  assert.equal(fs.readlinkSync(npmLink(home)), dshLink(home), "二级 → 一级");
  assert.ok(ready(msgs));
});

test("物化幂等：重复装载不告警、链接不变", async () => {
  const { mod, home } = await freshCase();
  const { ctx, msgs } = fakeCtx();
  mod.materializeCli(ctx);
  mod.materializeCli(ctx);
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN);
  assert.equal(fs.readlinkSync(npmLink(home)), dshLink(home));
  assert.ok(!blockedWarn(msgs));
  assert.ok(ready(msgs));
});

test("P1-2 回归：自有悬空链（旧安装残留）→ 接管重建，命令恢复", async () => {
  const { mod, home } = await freshCase();
  // 卸载时宿主被杀、disposer 没跑 → 留下指向旧安装布局的悬空链（目标含插件包名，且已不存在）
  const staleTarget = path.join(home, "old-layout", "node_modules", "@oh-summy", "dsh-remote", "bin", "dsh-web.mjs");
  fs.mkdirSync(path.dirname(dshLink(home)), { recursive: true });
  fs.symlinkSync(staleTarget, dshLink(home));
  const { ctx, msgs } = fakeCtx();
  mod.materializeCli(ctx);
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "悬空自有链被接管");
  assert.equal(fs.readlinkSync(npmLink(home)), dshLink(home), "二级正常建立");
  assert.ok(ready(msgs));
  assert.ok(msgs.some(([lv, m]) => lv === "info" && m.includes("接管")));
});

test("P1-2 回归：外来悬空链（目标不含插件包名）→ 绝不接管", async () => {
  const { mod, home } = await freshCase();
  const foreignDangling = path.join(home, "some-gone-tool", "dsh-web"); // 悬空且无插件标记
  fs.mkdirSync(path.dirname(dshLink(home)), { recursive: true });
  fs.symlinkSync(foreignDangling, dshLink(home));
  const { ctx, msgs } = fakeCtx();
  mod.materializeCli(ctx);
  assert.equal(fs.readlinkSync(dshLink(home)), foreignDangling, "外来悬空链原样保留");
  assert.ok(!existsAny(npmLink(home)), "不再建二级");
  assert.ok(!ready(msgs));
  assert.ok(blockedWarn(msgs));
});

test("P1-2 回归：一级被外来软链/普通文件占用 → 不覆盖、不建二级、不报就绪", async () => {
  for (const kind of ["symlink", "file"]) {
    const { mod, home } = await freshCase();
    fs.mkdirSync(path.dirname(dshLink(home)), { recursive: true });
    const foreign = path.join(home, "foreign-target");
    fs.writeFileSync(foreign, "user data");
    if (kind === "symlink") fs.symlinkSync(foreign, dshLink(home));
    else fs.writeFileSync(dshLink(home), "user file");
    const { ctx, msgs } = fakeCtx();
    mod.materializeCli(ctx);
    if (kind === "symlink") assert.equal(fs.readlinkSync(dshLink(home)), foreign, "外来软链原样保留");
    else assert.equal(fs.readFileSync(dshLink(home), "utf8"), "user file", "普通文件未被触碰");
    assert.ok(!existsAny(npmLink(home)), "不再建二级");
    assert.ok(!ready(msgs));
    assert.ok(blockedWarn(msgs));
  }
});

test("P1-2 回归：二级被外来软链占用 → 一级正常、外来二级保留、不报就绪", async () => {
  const { mod, home } = await freshCase();
  const { ctx } = fakeCtx();
  mod.materializeCli(ctx); // 两级干净 → 正常创建
  const foreign = path.join(home, "foreign-target2");
  fs.writeFileSync(foreign, "user data");
  fs.unlinkSync(npmLink(home));
  fs.symlinkSync(foreign, npmLink(home));
  const { ctx: ctx2, msgs } = fakeCtx();
  mod.materializeCli(ctx2);
  assert.equal(fs.readlinkSync(npmLink(home)), foreign, "外来二级不被接管");
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "一级不受影响");
  assert.ok(!ready(msgs));
});

test("回收：只撤自有软链；unlink 失败互不阻断", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) t.skip("root 下 chmod 目录无法制造 unlink 失败");
  const { mod, home } = await freshCase();
  const { ctx } = fakeCtx();
  mod.materializeCli(ctx);
  // 让二级 unlink 失败：目录置为不可写
  const npmDir = path.dirname(npmLink(home));
  fs.chmodSync(npmDir, 0o500);
  const { ctx: ctx2, msgs } = fakeCtx();
  mod.dematerializeCli(ctx2);
  assert.equal(existsAny(dshLink(home)), false, "一级不受二级失败阻断，仍被撤掉");
  assert.ok(existsAny(npmLink(home)), "二级因目录不可写而保留");
  assert.ok(msgs.some(([lv, m]) => lv === "warn" && m.includes(npmLink(home))), "失败有告警");
  fs.chmodSync(npmDir, 0o700); // 清场
  fs.unlinkSync(npmLink(home));
});

test("回收：目标本来就不存在 → 不抛错（lstat 断言，兼容悬空链）", async () => {
  const { mod, home } = await freshCase();
  const { ctx } = fakeCtx();
  mod.dematerializeCli(ctx);
  assert.equal(existsAny(dshLink(home)), false);
  assert.equal(existsAny(npmLink(home)), false);
});
