#!/usr/bin/env node
// publish-plugin.mjs — 把 plugins/<name>/ 镜像到独立分支 pkg/<name>（插件位于分支根）并打 <name>@vX.Y.Z tag。
// 为什么：pnpm 的用户 spec 无法表达「git 仓库 + 子目录」（实测 pnpm 11.9：# 后整体被当作 ref，
// github:owner/repo/subdir 被整体当作仓库名）；分支根 = 普通 git spec 即可安装，市场的 v* tag 空间不受影响。
// 实现：纯 plumbing（read-tree 子目录 → write-tree → commit-tree 链到 pkg/<name> 分支），不依赖新 git 特性。
// 源码事实源永远是 main 的 plugins/<name>/；本脚本只做镜像发布。tag 只进不移（重发同版本需手动 -f 并在 PR 说明）。
// 用法：node build/publish-plugin.mjs <name>
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];
if (!name) { console.error("usage: node build/publish-plugin.mjs <plugin-name>"); process.exit(1); }
const run = (cmd, env = {}) => execSync(cmd, { encoding: "utf8", env: { ...process.env, ...env } }).trim();
const pkgDir = join("plugins", name);
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const tag = `${name}@v${version}`;
const branch = `pkg/${name}`;
const tmpIndex = join(run("git rev-parse --git-dir"), "pkg-index");

// 1) 以 main 的插件子目录为内容构造 tree（不碰工作区/主 index）
const tree = run(`git read-tree HEAD:${pkgDir} && git write-tree`, { GIT_INDEX_FILE: tmpIndex });

// 2) 提交到 pkg/<name> 分支（父提交 = 分支现有 tip，首发布无父）
let parents = "";
try { parents = `-p ${run(`git rev-parse ${branch}`)}`; } catch { /* 首次 */ }
const commit = run(`git commit-tree ${tree} ${parents} -m "publish ${name} v${version} (mirror of ${pkgDir} @ ${run("git rev-parse --short HEAD")})"`);
run(`git update-ref refs/heads/${branch} ${commit}`);

// 3) 打 tag（存在即报，不移动）
try { run(`git tag ${tag} ${commit}`); }
catch { console.log(`tag ${tag} 已存在于本分支历史——同版本重发需手动 -f 并在 PR 说明`); }

rmSync(tmpIndex, { force: true });
console.log(`done: ${branch} → ${commit}`);
console.log(`      tag ${tag} → ${run(`git rev-parse ${tag}`)}`);
console.log(`push: git push origin ${branch} ${tag}`);
