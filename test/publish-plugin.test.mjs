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
