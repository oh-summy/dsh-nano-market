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

test("the tab paints from a bundled market snapshot, so the first paint needs no network", () => {
  const snapshot = JSON.parse(readFileSync(join(pkgDir, "src/market-snapshot.json"), "utf8"));
  assert.ok(Array.isArray(snapshot.entries));
  assert.ok(snapshot.entries.length > 0, "the snapshot must carry this market's entries");
  for (const entry of snapshot.entries) {
    assert.ok(entry.name, "every entry needs its package name");
    assert.ok(entry.title, "every entry needs a title");
    assert.ok(entry.versions.length > 0, "every entry needs at least one version");
    // the install spec must be a pinned commit, never a floating tag
    assert.match(entry.versions[0].install.spec, /^git\+https:\/\/[^#]+#[0-9a-f]{40}$/);
  }
  // the built client inlines it
  const built = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
  assert.match(built, /const MARKET_SNAPSHOT = /);
  assert.ok(built.includes(snapshot.entries[0].name), "the built client must carry the snapshot entries");
});

test("the snapshot's install specs match the official market derivation", async () => {
  const { installTarget } = await import("../scripts/gen-snapshot.mjs");
  const { marketInstallTarget } = await import("@deepseek-ai/dsh-plugin-market-index");
  const snapshot = JSON.parse(readFileSync(join(pkgDir, "src/market-snapshot.json"), "utf8"));
  const index = JSON.parse(readFileSync(join(pkgDir, "../../dist/index.json"), "utf8"));
  for (const plugin of index.plugins) {
    const ours = snapshot.entries.find((entry) => entry.name === plugin.name);
    assert.ok(ours, `${plugin.name} must be in the snapshot`);
    for (const version of plugin.versions) {
      const expected = marketInstallTarget(plugin.name, version);
      const mine = installTarget(plugin.name, version);
      assert.equal(mine.spec, expected.spec);
    }
  }
});

test("the tab uses the host's own components and tokens, not a look of its own", () => {
  const source = readFileSync(join(pkgDir, "client-src/client.js"), "utf8");
  // host primitives: the same switch, tag, button and default artwork the
  // host's own plugin list uses
  assert.match(source, /P\.Switch/);
  assert.match(source, /P\.Tag/);
  assert.match(source, /P\.Button/);
  assert.match(source, /P\.PluginArtworkDefault/);
  // host design tokens, not hard-coded colours
  assert.match(source, /--dsw-alias-label-primary/);
  assert.match(source, /--dsw-radius-xl/);
  // children live in props.children (this runtime ignores a third array argument)
  assert.doesNotMatch(source, /jsx[s]?\([^)]*\},\s*\[/);
});

test("bundle patch inserts the plugin without a second enable switch", () => {
  const patch = readFileSync(join(pkgDir, "cordis.patch.yml"), "utf8");
  assert.match(patch, /name: "@oh-summy\/nano-market"/);
  assert.doesNotMatch(patch, /enabled:/);
});
