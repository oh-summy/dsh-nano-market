// 物化/回收单测：软链只创建不覆盖、自有悬空链接管、卸载只撤自有链接、世代守卫、失败互不阻断。
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
const ownerFile = (home) => path.join(home, ".remote-control", "run-plugin", "cli-links-owner.json");

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

test("物化：两级软链创建 + 就绪日志 + 返回属主代，链接链正确", async () => {
  const { mod, home } = await freshCase();
  const { ctx, msgs } = fakeCtx();
  const gen = mod.materializeCli(ctx);
  assert.match(gen, /^[0-9a-f]{16}$/, "返回 16 hex（8 字节）属主代");
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "一级 → 插件包内 bin");
  assert.equal(fs.readlinkSync(npmLink(home)), dshLink(home), "二级 → 一级");
  assert.ok(ready(msgs));
  const owner = JSON.parse(fs.readFileSync(ownerFile(home), "utf8"));
  assert.equal(owner.gen, gen, "属主登记与返回代一致");
  assert.equal(owner.pid, process.pid);
});

test("物化幂等：重复装载不告警、链接不变、属主代刷新", async () => {
  const { mod, home } = await freshCase();
  const { ctx, msgs } = fakeCtx();
  const gen1 = mod.materializeCli(ctx);
  const gen2 = mod.materializeCli(ctx);
  assert.notEqual(gen1, gen2, "每次装载新的属主代");
  assert.equal(JSON.parse(fs.readFileSync(ownerFile(home), "utf8")).gen, gen2);
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN);
  assert.ok(!blockedWarn(msgs));
  assert.ok(ready(msgs));
});

test("世代守卫：属主代已更替（entry 重启/另一实例接管）→ 跳过回收", async () => {
  const { mod, home } = await freshCase();
  const { ctx } = fakeCtx();
  const gen1 = mod.materializeCli(ctx);
  // 模拟另一实例接管：属主文件被改写
  fs.writeFileSync(ownerFile(home), JSON.stringify({ pid: process.pid, gen: "ffffffff" }));
  mod.dematerializeCli(ctx, gen1);
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "链接被新属主保留");
  assert.equal(fs.readlinkSync(npmLink(home)), dshLink(home));
  // 新属主用自己的代回收 → 成功
  mod.dematerializeCli(ctx, "ffffffff");
  assert.equal(existsAny(dshLink(home)), false);
  assert.equal(existsAny(npmLink(home)), false);
});

test("世代守卫：本次装载未接管链接（gen=null）→ 无权回收", async () => {
  const { mod, home } = await freshCase();
  fs.mkdirSync(path.dirname(dshLink(home)), { recursive: true });
  fs.writeFileSync(dshLink(home), "user file"); // 一级被普通文件占用 → materialize 返回 null
  const { ctx } = fakeCtx();
  const gen = mod.materializeCli(ctx);
  assert.equal(gen, null);
  mod.dematerializeCli(ctx, gen);
  assert.equal(fs.readFileSync(dshLink(home), "utf8"), "user file", "用户文件未被触碰");
});

test("P1-2 回归：自有悬空链（旧安装残留）→ 接管重建，命令恢复", async () => {
  const { mod, home } = await freshCase();
  const staleTarget = path.join(home, "old-layout", "node_modules", "@oh-summy", "dsh-remote", "bin", "dsh-web.mjs");
  fs.mkdirSync(path.dirname(dshLink(home)), { recursive: true });
  fs.symlinkSync(staleTarget, dshLink(home));
  const { ctx, msgs } = fakeCtx();
  const gen = mod.materializeCli(ctx);
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "悬空自有链被接管");
  assert.equal(fs.readlinkSync(npmLink(home)), dshLink(home), "二级正常建立");
  assert.ok(ready(msgs));
  assert.ok(msgs.some(([lv, m]) => lv === "info" && m.includes("接管")));
  mod.dematerializeCli(ctx, gen); // 清场
  assert.equal(existsAny(dshLink(home)), false);
});

test("P1-2 回归：外来悬空链（目标不含插件包名）→ 绝不接管", async () => {
  const { mod, home } = await freshCase();
  const foreignDangling = path.join(home, "some-gone-tool", "dsh-web");
  fs.mkdirSync(path.dirname(dshLink(home)), { recursive: true });
  fs.symlinkSync(foreignDangling, dshLink(home));
  const { ctx, msgs } = fakeCtx();
  const gen = mod.materializeCli(ctx);
  assert.equal(gen, null);
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
    const gen = mod.materializeCli(ctx);
    assert.equal(gen, null);
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
  mod.materializeCli(ctx);
  const foreign = path.join(home, "foreign-target2");
  fs.writeFileSync(foreign, "user data");
  fs.unlinkSync(npmLink(home));
  fs.symlinkSync(foreign, npmLink(home));
  const { ctx: ctx2, msgs } = fakeCtx();
  const gen = mod.materializeCli(ctx2);
  assert.equal(gen, null, "二级被外来占用 = 未完全接管，不返回属主代");
  assert.equal(fs.readlinkSync(npmLink(home)), foreign, "外来二级不被接管");
  assert.equal(fs.readlinkSync(dshLink(home)), REPO_BIN, "一级不受影响");
  assert.ok(!ready(msgs));
});

test("回收：只撤自有软链；unlink 失败互不阻断", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) t.skip("root 下 chmod 目录无法制造 unlink 失败");
  const { mod, home } = await freshCase();
  const { ctx } = fakeCtx();
  const gen = mod.materializeCli(ctx);
  const npmDir = path.dirname(npmLink(home));
  fs.chmodSync(npmDir, 0o500);
  const { ctx: ctx2, msgs } = fakeCtx();
  mod.dematerializeCli(ctx2, gen);
  assert.equal(existsAny(dshLink(home)), false, "一级不受二级失败阻断，仍被撤掉");
  assert.ok(existsAny(npmLink(home)), "二级因目录不可写而保留");
  assert.ok(msgs.some(([lv, m]) => lv === "warn" && m.includes(npmLink(home))), "失败有告警");
  fs.chmodSync(npmDir, 0o700);
  fs.unlinkSync(npmLink(home));
});

test("回收：属主文件缺失 → 按传入代回收，目标不存在不抛错", async () => {
  const { mod, home } = await freshCase();
  const { ctx } = fakeCtx();
  mod.materializeCli(ctx);
  fs.rmSync(ownerFile(home)); // 模拟属主登记写入失败
  mod.dematerializeCli(ctx, "deadbeef");
  assert.equal(existsAny(dshLink(home)), false);
  assert.equal(existsAny(npmLink(home)), false);
  mod.dematerializeCli(ctx, "deadbeef"); // 再来一次：目标已不在，不抛错
  assert.equal(existsAny(dshLink(home)), false);
  assert.equal(existsAny(npmLink(home)), false);
});
