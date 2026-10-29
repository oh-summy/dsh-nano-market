import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cwd, args) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim();

test("publish-plugin refuses same-version republish before moving pkg branch", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-publish-test-"));
  try {
    fs.mkdirSync(path.join(cwd, "plugins/demo"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "build"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "plugins/demo/package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.writeFileSync(path.join(cwd, "plugins/demo/file.txt"), "first");
    fs.copyFileSync(path.resolve("build/publish-plugin.mjs"), path.join(cwd, "build/publish-plugin.mjs"));
    run(cwd, ["git", "init", "-b", "main"]);
    run(cwd, ["git", "config", "user.email", "test@example.com"]);
    run(cwd, ["git", "config", "user.name", "Test"]);
    run(cwd, ["git", "add", "."]);
    run(cwd, ["git", "commit", "-m", "first"]);
    run(cwd, [process.execPath, "build/publish-plugin.mjs", "demo"]);
    const branchTip = run(cwd, ["git", "rev-parse", "pkg/demo"]);

    fs.writeFileSync(path.join(cwd, "plugins/demo/file.txt"), "second");
    run(cwd, ["git", "add", "."]);
    run(cwd, ["git", "commit", "-m", "same version changed source"]);
    assert.throws(() => run(cwd, [process.execPath, "build/publish-plugin.mjs", "demo"]), /Command failed/);
    assert.equal(run(cwd, ["git", "rev-parse", "pkg/demo"]), branchTip);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("publish-plugin links the mirror branch across a fresh clone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-publish-fresh-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const clone = path.join(root, "clone");
  const script = path.resolve("build/publish-plugin.mjs");
  try {
    fs.mkdirSync(path.join(work, "plugins/demo"), { recursive: true });
    fs.mkdirSync(path.join(work, "build"), { recursive: true });
    fs.copyFileSync(script, path.join(work, "build/publish-plugin.mjs"));
    run(work, ["git", "init", "-b", "main"]);
    run(work, ["git", "config", "user.email", "test@example.com"]);
    run(work, ["git", "config", "user.name", "Test"]);
    fs.writeFileSync(path.join(work, "plugins/demo/package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.writeFileSync(path.join(work, "plugins/demo/file.txt"), "v1");
    run(work, ["git", "add", "."]);
    run(work, ["git", "commit", "-m", "v1"]);
    run(work, [process.execPath, "build/publish-plugin.mjs", "demo"]);
    run(work, ["git", "init", "--bare", "-b", "main", origin]);
    run(work, ["git", "remote", "add", "origin", origin]);
    run(work, ["git", "push", "--atomic", "origin", "main", "pkg/demo", "demo@v1.0.0"]);

    // bump the version and publish the next mirror
    fs.writeFileSync(path.join(work, "plugins/demo/package.json"), JSON.stringify({ version: "1.1.0" }));
    fs.writeFileSync(path.join(work, "plugins/demo/file.txt"), "v2");
    run(work, ["git", "add", "."]);
    run(work, ["git", "commit", "-m", "v2"]);
    run(work, ["git", "push", "origin", "main"]);

    // fresh clone: tag exists, no local pkg branch, remote-tracking branch exists
    run(work, ["git", "clone", origin, clone]);
    const hasTag = run(clone, ["git", "for-each-ref", "--format=%(refname)", "refs/tags/demo@v1.0.0"]).length > 0;
    const hasLocalBranch = run(clone, ["git", "for-each-ref", "--format=%(refname)", "refs/heads/pkg/demo"]).length > 0;
    const hasRemoteBranch = run(clone, ["git", "for-each-ref", "--format=%(refname)", "refs/remotes/origin/pkg/demo"]).length > 0;
    assert.ok(hasTag, "fresh clone should carry the previous tag");
    assert.equal(hasLocalBranch, false, "fresh clone should not have a local pkg branch");
    assert.ok(hasRemoteBranch, "fresh clone should track origin pkg branch");

    run(clone, [process.execPath, "build/publish-plugin.mjs", "demo", "--push"]);
    const branchTip = run(clone, ["git", "rev-parse", "pkg/demo"]);
    const tagCommit = run(clone, ["git", "rev-parse", "demo@v1.1.0^{commit}"]);
    const v1Commit = run(clone, ["git", "rev-parse", "demo@v1.0.0^{commit}"]);
    assert.equal(tagCommit, branchTip);
    assert.equal(run(clone, ["git", "rev-parse", "demo@v1.1.0^{commit}^"]), v1Commit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
