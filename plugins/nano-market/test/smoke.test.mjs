import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

test("package exposes a web client module for the market tab", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@oh-summy/nano-market");
  assert.equal(pkg.dsh.client?.platform, "web");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.ok(pkg.keywords.includes("dsh"));
  assert.ok(pkg.keywords.includes("dsh-plugin"));
  assert.match(pkg.scripts.build, /build-client.mjs/);
});

test("client registers the Nano Market tab with the host-provided props", () => {
  const source = readFileSync(join(pkgDir, "client-src/client.js"), "utf8");
  assert.match(source, /ctx\.slots\.inject\("plugins\.tab"/);
  assert.match(source, /id: "nano-market"/);
  assert.match(source, /label: \(\) => t\("title"\)/);
  // host props: install + openPackage
  assert.match(source, /props\.install\(/);
  assert.match(source, /props\.openPackage\(/);
  // lifecycle actions go through the host pluginManager
  assert.match(source, /pluginManager\.setBundleEnabled/);
  assert.match(source, /pluginManager\.setBundleEnabled/);
  // the market index is this market's own published index
  assert.match(source, /oh-summy\.github\.io\/dsh-nano-market\/index\.json/);
});

test("bundle patch inserts the plugin without a second enable switch", () => {
  const patch = readFileSync(join(pkgDir, "cordis.patch.yml"), "utf8");
  assert.match(patch, /name: "@oh-summy\/nano-market"/);
  assert.doesNotMatch(patch, /enabled:/);
});
