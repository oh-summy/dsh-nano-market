#!/usr/bin/env node
// publish-plugin.mjs — 把 plugins/<name>/ 镜像到独立分支 pkg/<name>（插件位于分支根）并打 <name>@vX.Y.Z tag。
// 为什么：pnpm 的用户 spec 无法表达「git 仓库 + 子目录」（实测 pnpm 11.9：# 后整体被当作 ref，
// github:owner/repo/subdir 被整体当作仓库名）；分支根 = 普通 git spec 即可安装，市场的 v* tag 空间不受影响。
// 实现：纯 plumbing（read-tree 子目录 → write-tree → commit-tree 链到 pkg/<name> 分支），不依赖新 git 特性。
// 源码事实源永远是 main 的 plugins/<name>/；本脚本只做镜像发布。
//
// 安全约束（2026-10-29 审查修复）：
//   1) 插件名只允许 [A-Za-z0-9_-]，拒绝路径穿越；
//   2) 版本与内容一律从 HEAD 提交读取，不读工作区，避免 dirty tree 发布；
//   3) 存在 origin 时，要求工作区干净且 HEAD == origin/main，并校验远端同名 tag/分支；
//   4) push 使用 --atomic，push 后校验 tag^{commit} == pkg 分支 tip；
//   5) 同名 tag 一律失败（tag 只进不移），杜绝「分支新、tag 旧」的假发布。
// 用法：node build/publish-plugin.mjs <name> [--push]
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const name = args[0];
const push = args.includes("--push");
if (!name) { console.error("usage: node build/publish-plugin.mjs <plugin-name> [--push]"); process.exit(1); }
if (!/^[A-Za-z0-9_-]+$/.test(name)) {
  console.error(`invalid plugin name: ${name}`);
  process.exit(1);
}

const run = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();
const pkgDir = join("plugins", name);
const branch = `pkg/${name}`;
const tmpIndex = join(run("git rev-parse --git-dir"), "pkg-index");

// 1) 名称/版本/内容全部取自 HEAD，保证发布与提交一致。
const headPkg = run(`git show HEAD:${pkgDir}/package.json`);
const version = JSON.parse(headPkg).version;
const tag = `${name}@v${version}`;
const cleanupTmp = () => rmSync(tmpIndex, { force: true });
process.on("exit", cleanupTmp);
process.on("SIGINT", () => { cleanupTmp(); process.exit(130); });

// 2) 远端存在时，先做安全 guard。
const hasOrigin = (() => { try { run("git remote get-url origin"); return true; } catch { return false; } })();
// Dirty check applies regardless of origin: never publish from a dirty tree.
const dirty = run("git status --porcelain").trim();
if (dirty) { console.error("working tree is dirty; commit or stash before publishing"); process.exit(1); }
if (hasOrigin) {
  run("git fetch origin --tags");
  const head = run("git rev-parse HEAD");
  const originMain = run("git rev-parse origin/main");
  if (head !== originMain) { console.error(`HEAD (${head}) is not origin/main (${originMain})`); process.exit(1); }
  // ls-remote exits 0 even when nothing matches, so check the output.
  const remoteTag = run(`git ls-remote --tags origin ${tag}`).length > 0;
  if (remoteTag) {
    console.error(`tag ${tag} already exists on origin; bump the plugin version before republishing`);
    process.exit(1);
  }
}

// 3) 本地同名 tag 也一律拒绝（fresh clone 或上次发布残留）。
let tagExists = false;
try { run(`git rev-parse -q --verify refs/tags/${tag}`); tagExists = true; } catch { /* new tag */ }
if (tagExists) {
  console.error(`tag ${tag} already exists locally; bump the plugin version before republishing`);
  process.exit(1);
}

// 4) 以 HEAD 的插件子目录为内容构造 tree（不碰工作区/主 index）。
// GIT_INDEX_FILE 必须经 env 传给 git：execSync 的裸键会被忽略，
// 否则 read-tree 会把插件子树读进主索引，整仓索引被替换成插件目录（2026-11-01 实测事故）。
const tree = run(`git read-tree HEAD:${pkgDir} && git write-tree`, { env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });

// 5) 提交到 pkg/<name> 分支（父提交 = 分支现有 tip，首发布无父）。
let parents = "";
let branchTip = "";
try { branchTip = run(`git rev-parse ${branch}`); } catch { /* local absent */ }
if (!branchTip) { try { branchTip = run(`git rev-parse origin/${branch}`); } catch { /* first publish */ } }
if (branchTip) parents = `-p ${branchTip}`;
const commit = run(`git commit-tree ${tree} ${parents} -m "publish ${name} v${version} (mirror of ${pkgDir} @ ${run("git rev-parse --short HEAD")})"`);
run(`git update-ref refs/heads/${branch} ${commit}`);
run(`git tag ${tag} ${commit}`);

// 6) push（有 origin 且要求时）并做原子校验。
if (hasOrigin && push) {
  run(`git push --atomic origin ${branch} ${tag}`);
  const remoteBranchTip = run(`git rev-parse origin/${branch}`);
  const remoteTagCommit = run(`git rev-parse ${tag}^{commit}`);
  if (remoteTagCommit !== remoteBranchTip) {
    console.error(`tag ${tag} (${remoteTagCommit}) does not match ${branch} tip (${remoteBranchTip})`);
    process.exit(1);
  }
}

console.log(`done: ${branch} → ${commit}`);
console.log(`      tag ${tag} → ${run(`git rev-parse ${tag}`)}`);
if (!(hasOrigin && push)) {
  console.log(`push: git push --atomic origin ${branch} ${tag}`);
}
