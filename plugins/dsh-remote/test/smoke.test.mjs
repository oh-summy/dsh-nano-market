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
test("dsh-remote no longer claims a Plugins page tab", () => {
  const source = readFileSync(join(pkgDir, "client-src/client.js"), "utf8");
  assert.doesNotMatch(source, /slots\.inject\("plugins\.tab"/);
  // config lives in the keyed plugins.bundle.config slot (host places it above the
  // host's 来源信息 section), not a page tab and not the below-info detail slot.
  assert.match(source, /slots\.inject\("plugins\.bundle\.config"/);
  assert.doesNotMatch(source, /slots\.inject\("plugins\.detail\.section"/);
  assert.match(source, /key: PACKAGE/);
});

test("dsh-remote config section only draws on its own package page", () => {
  const source = readFileSync(join(pkgDir, "client-src/client.js"), "utf8");
  // The keyed slot (key: PACKAGE) means the host renders this card only on
  // dsh-remote's own detail page.
  assert.match(source, /key: PACKAGE/);
  // The manager mounts only in the full page view, never the one-line summary.
  assert.match(source, /view === "summary"/);
});
