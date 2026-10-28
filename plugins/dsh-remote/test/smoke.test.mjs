import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// dsh-remote smoke tests: verify the plugin builds, loads, and exposes
// the expected contract. Process management (cloudflared/caddy) cannot
// be tested in CI without those binaries installed.

test("dsh-remote builds and loads", async () => {
  const mod = await import("../lib/index.mjs");
  assert.equal(typeof mod.apply, "function");
  assert.equal(typeof mod.inject, "object");
  assert.ok(Array.isArray(mod.inject));
});

test("dsh-remote injects credentials", async () => {
  const { inject } = await import("../lib/index.mjs");
  assert.ok(inject.includes("credentials"));
});

test("dsh-remote package.json is valid", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@oh-summy/dsh-remote");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.engines?.dsh);
  assert.ok(pkg.engines?.node);
});

test("dsh-remote cordis.patch.yml has correct bundle id", () => {
  const text = readFileSync(join(pkgDir, "cordis.patch.yml"), "utf8");
  assert.match(text, /id:\s*dsh-remote/);
  assert.match(text, /name:\s*"?@oh-summy\/dsh-remote"?/);
});