// market-logic 行为级测试：归一化保留宿主更新资格 → updateTarget 选择规则 →
// 更新载荷构造（PluginTabUpdate）。直接 import 源文件（纯逻辑，无 React/宿主依赖）——
// 构建（build-client.mjs）把同一份实现拼进客户端包体，两条消费路径、一份实现。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEntry, normalizeEntries, updateTarget, updatePayloadOf, presentedVersion, parseStateCache, STATE_CACHE_TTL, switchLockedOut } from "../client-src/market-logic.js";;

// 宿主实时数据形态：版本对象由宿主 listing 计算 update 资格（布尔），
// install.spec 是「pin 到完整 commit 的 git spec」（git 源）。
const hostVersion = (over = {}) => ({
  version: "0.4.0",
  engines: { dsh: ">=0.2.1-rc.4" },
  install: { spec: "git+https://github.com/oh-summy/dsh-nano-market.git#43f45eff17577fa4208d96c0a424c2042c85d781" },
  update: true,
  ...over,
});
const hostEntry = (versions, over = {}) => ({
  name: "@oh-summy/dsh-remote",
  title: { en: "dsh-remote" },
  description: { en: "remote access" },
  defaultVersion: versions[0]?.version,
  versions,
  installation: { status: "update-available" },
  ...over,
});

test("normalizeEntry：保留宿主的 update 资格布尔与 install 规格（P0-1 回归）", () => {
  const raw = hostEntry([hostVersion()]);
  const entry = normalizeEntry(raw);
  assert.equal(entry.versions[0].update, true, "update 资格必须存活（此前被归一化丢弃=按钮永不可达）");
  assert.equal(entry.versions[0].install.spec, raw.versions[0].install.spec);
  assert.equal(entry.installation.status, "update-available");
  assert.equal(normalizeEntries([raw])[0].versions[0].update, true);
});

test("updateTarget：presented 可更新时优先返回", () => {
  const entry = hostEntry([hostVersion({ version: "0.4.0" })]);
  const target = updateTarget(entry);
  assert.equal(target.version, "0.4.0");
});

test("updateTarget：presented 不可更新时找第一个稳定可更新版本，跳过预发布", () => {
  const entry = hostEntry([
    hostVersion({ version: "0.5.0-rc.1", update: false }),
    hostVersion({ version: "0.4.0", update: true }),
  ]);
  const target = updateTarget(entry);
  assert.equal(target.version, "0.4.0", "预发布与不可更新版本被跳过");
});

test("updateTarget：兼容性不满足的版本不可更新", () => {
  const entry = hostEntry([
    hostVersion({ version: "0.4.0", compatibility: { compatible: false } }),
  ]);
  assert.equal(updateTarget(entry), undefined);
});

test("updateTarget：update 资格缺失（如 npm 源）→ undefined（不渲染按钮）", () => {
  const npmEntry = hostEntry([{ version: "1.2.0", install: { spec: "some-plugin@1.2.0", registry: "https://registry.npmjs.org" } }]);
  delete npmEntry.versions[0].update;
  assert.equal(updateTarget(npmEntry), undefined, "npm 源不该进入 openGitUpdate");
});

test("updatePayloadOf：严格构造 PluginTabUpdate（spec 取 install.spec，官方同款）", () => {
  const entry = normalizeEntry(hostEntry([hostVersion()]));
  assert.deepEqual(updatePayloadOf(entry), {
    packageName: "@oh-summy/dsh-remote",
    version: "0.4.0",
    spec: "git+https://github.com/oh-summy/dsh-nano-market.git#43f45eff17577fa4208d96c0a424c2042c85d781",
  });
});

test("updatePayloadOf：无资格 / 无 install 规格 → null（不渲染按钮）", () => {
  assert.equal(updatePayloadOf(normalizeEntry(hostEntry([hostVersion({ update: false })]))), null);
  const noInstall = hostEntry([hostVersion()]);
  delete noInstall.versions[0].install;
  assert.equal(updatePayloadOf(normalizeEntry(noInstall)), null, "没有可执行规格就没有载荷");
});

test("updatePayloadOf：update 为对象（错误的旧数据形状）→ 仍拒绝（spec 取 install.spec，不读 update.spec）", () => {
  const entry = normalizeEntry(hostEntry([hostVersion({ update: { spec: "should-not-be-read" } })]));
  const payload = updatePayloadOf(entry);
  assert.equal(payload.spec, "git+https://github.com/oh-summy/dsh-nano-market.git#43f45eff17577fa4208d96c0a424c2042c85d781");
});
// ---------- 首屏状态缓存校验（审查 P1-3 回归） ----------
const validCache = () => ({
  entries: [{ name: "@oh-summy/dsh-remote", versions: [{ version: "0.4.0" }] }],
  bundles: { "@oh-summy/dsh-remote": { installed: true, enabled: true } },
  savedAt: Date.now() - 1000,
});

test("parseStateCache：结构完整且在 TTL 内才有效", () => {
  const now = Date.now();
  assert.deepEqual(parseStateCache(validCache(), now), validCache());
  assert.equal(parseStateCache(null, now), null);
  assert.equal(parseStateCache([], now), null);
  assert.equal(parseStateCache({}, now), null);
  assert.equal(parseStateCache({ entries: [], bundles: {} }, now), null);            // 空条目
  assert.equal(parseStateCache({ entries: validCache().entries }, now), null);        // 缺 bundles
  assert.equal(parseStateCache({ ...validCache(), bundles: [] }, now), null);         // bundles 是数组
  assert.equal(parseStateCache({ ...validCache(), savedAt: now - STATE_CACHE_TTL - 1 }, now), null); // 过期
  assert.equal(parseStateCache({ ...validCache(), savedAt: now + 120_000 }, now), null);             // 未来时钟
  assert.equal(parseStateCache({ ...validCache(), savedAt: "x" }, now), null);        // 非数值
});

// ---------- 开关锁定条件（审查 P1-2 回归） ----------
test("switchLockedOut：读取失败/未装入/宿主内置/只读/忙碌/未获实时确认 → 禁用", () => {
  assert.equal(switchLockedOut({ working: false, locked: false, status: "enabled", readFailed: false, fresh: true }), false);
  assert.equal(switchLockedOut({ working: false, locked: false, status: "installed-off", readFailed: false, fresh: true }), false);
  assert.equal(switchLockedOut({ working: false, locked: false, status: "not-installed", readFailed: false, fresh: true }), true);
  assert.equal(switchLockedOut({ working: false, locked: false, status: "provided", readFailed: false, fresh: true }), true);
  assert.equal(switchLockedOut({ working: true, locked: false, status: "enabled", readFailed: false, fresh: true }), true);
  assert.equal(switchLockedOut({ working: false, locked: true, status: "enabled", readFailed: false, fresh: true }), true);
});

test("switchLockedOut：本轮实时清单未确认（fresh=false）→ 一律禁用（审查 P1-3：缓存只管视觉）", () => {
  for (const status of ["enabled", "installed-off", "unknown", "not-installed", "provided"]) {
    assert.equal(switchLockedOut({ working: false, locked: false, status, readFailed: false, fresh: false }), true);
  }
});

test("switchLockedOut：读取失败 → 禁用（不按陈旧/未知状态操作）", () => {
  assert.equal(switchLockedOut({ working: false, locked: false, status: "enabled", readFailed: true, fresh: true }), true);
});
