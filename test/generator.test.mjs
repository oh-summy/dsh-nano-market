// test/generator.test.mjs — offline golden tests for the generator core (node:test).
// The "fail loudly, no silent skip" promise (AGENTS.md §1.3) must be proven, not asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitRepo, normalizeRepoUrl, checkPin, gitPluginFromManifest, npmPluginFromPackument, withMeta } from "../build/lib.mjs";

const validManifest = {
  name: "@oh-summy/dsh-remote",
  version: "0.1.0",
  engines: { dsh: ">=0.2.1-rc.2" },
  dsh: { bundle: { patch: "./cordis.patch.yml" } }
};
const validEntry = {
  kind: "git", name: "@oh-summy/dsh-remote",
  repo: "https://github.com/oh-summy/dsh-example",
  path: "plugin", ref: "v1.0.0", pinnedCommit: "b".repeat(40),
  meta: { title: { en: "Remote Control", zh: "远程接入" }, category: "infra", labels: ["mine"], keywords: ["remote"] }
};
const COMMIT = "c".repeat(40);

test("splitRepo: canonical github urls", () => {
  assert.deepEqual(splitRepo("https://github.com/oh-summy/dsh-example"), { owner: "oh-summy", repoName: "dsh-example" });
  assert.deepEqual(splitRepo("https://github.com/oh-summy/dsh-example.git"), { owner: "oh-summy", repoName: "dsh-example" });
  assert.deepEqual(splitRepo("https://github.com/oh-summy/dsh-example.git/"), { owner: "oh-summy", repoName: "dsh-example" });
  assert.equal(splitRepo("git@github.com:oh-summy/dsh-example.git"), null);
  assert.equal(splitRepo("https://github.com/oh-summy"), null);
  assert.equal(splitRepo("https://gitlab.com/oh-summy/x"), null);
});

test("normalizeRepoUrl: canonical form", () => {
  assert.equal(normalizeRepoUrl("https://github.com/oh-summy/dsh-example.git/"), "https://github.com/oh-summy/dsh-example");
  assert.equal(normalizeRepoUrl("not a url"), null);
});

test("checkPin: missing pin / moved tag / ok", () => {
  assert.throws(() => checkPin({ name: "x", ref: "v1" }, COMMIT), /missing pinnedCommit/);
  assert.throws(() => checkPin({ name: "x", ref: "v1", pinnedCommit: "a".repeat(40) }, COMMIT), /the tag moved/);
  assert.doesNotThrow(() => checkPin({ name: "x", ref: "v1", pinnedCommit: COMMIT }, COMMIT));
});

test("gitPluginFromManifest: valid manifest -> format-1 plugin", () => {
  const pl = gitPluginFromManifest(validManifest, validEntry, COMMIT, 1792000000);
  assert.equal(pl.name, "@oh-summy/dsh-remote");
  const v = pl.versions[0];
  assert.equal(v.version, "0.1.0");
  assert.equal(v.publishTimestamp, 1792000000);
  assert.equal(v.source.type, "git");
  assert.equal(v.source.url, "https://github.com/oh-summy/dsh-example");
  assert.equal(v.source.commit, COMMIT);
  assert.equal(v.source.path, "plugin");
  assert.equal(v.engines.dsh, ">=0.2.1-rc.2");
  assert.equal(pl.title.en, "Remote Control");
  assert.deepEqual(pl.metadata, { category: "infra", keywords: ["remote"], labels: ["mine"] });
});

test("gitPluginFromManifest: name mismatch fails loudly", () => {
  assert.throws(() => gitPluginFromManifest({ ...validManifest, name: "@other/pkg" }, validEntry, COMMIT, 0), /catalog name/);
});

test("gitPluginFromManifest: missing engines.dsh fails loudly", () => {
  const noEngines = { name: validManifest.name, version: validManifest.version, dsh: validManifest.dsh };
  assert.throws(() => gitPluginFromManifest(noEngines, validEntry, COMMIT, 0), /engines.dsh/);
});

test("gitPluginFromManifest: missing dsh.bundle fails loudly", () => {
  const noBundle = { name: validManifest.name, version: "0.1.0", engines: { dsh: "*" } };
  assert.throws(() => gitPluginFromManifest(noBundle, validEntry, COMMIT, 0), /dsh.bundle/);
});

test("npmPluginFromPackument: eligibility filters + dist-tag intersection", () => {
  const packument = {
    time: { "0.1.0": "2026-09-01T00:00:00Z", "0.2.0": "2026-10-01T00:00:00Z" },
    versions: {
      "0.1.0": { ...validManifest, version: "0.1.0" },
      "0.2.0": { ...validManifest, version: "0.2.0", deprecated: "old" },
      "0.3.0": { name: validManifest.name, version: "0.3.0" }
    },
    "dist-tags": { latest: "0.2.0", beta: "0.1.0" }
  };
  const pl = npmPluginFromPackument(packument, { name: "@oh-summy/dsh-remote" });
  assert.deepEqual(pl.versions.map((v) => v.version), ["0.1.0"]);
  assert.equal(pl["dist-tags"].beta, "0.1.0");
  assert.equal(pl["dist-tags"].latest, undefined);
});

test("npmPluginFromPackument: no eligible version fails loudly", () => {
  assert.throws(() => npmPluginFromPackument({ versions: {} }, { name: "@oh-summy/dsh-x" }), /no eligible versions/);
});

test("gitPluginFromManifest: distTags must point at the manifest version", () => {
  const ok = gitPluginFromManifest(validManifest, { ...validEntry, distTags: { latest: "0.1.0" } }, COMMIT, 0);
  assert.equal(ok["dist-tags"].latest, "0.1.0");
  assert.throws(
    () => gitPluginFromManifest(validManifest, { ...validEntry, distTags: { latest: "9.9.9" } }, COMMIT, 0),
    /dist-tags must point at the listed version/
  );
});

test("npmPluginFromPackument: author = dist-tags.latest when eligible, else newest publish time", () => {
  const packument = {
    time: { "0.1.0": "2026-09-01T00:00:00Z", "0.2.0": "2026-10-01T00:00:00Z" },
    versions: {
      "0.1.0": { ...validManifest, version: "0.1.0", author: { name: "early" } },
      "0.2.0": { ...validManifest, version: "0.2.0", author: { name: "current" } }
    },
    "dist-tags": { latest: "0.2.0" }
  };
  assert.equal(npmPluginFromPackument(packument, { name: "@oh-summy/dsh-remote" }).author, "current");
  const noTag = { ...packument, "dist-tags": {} };
  assert.equal(npmPluginFromPackument(noTag, { name: "@oh-summy/dsh-remote" }).author, "current");
  // packument object order must never be trusted: 0.1.0 published later despite lower semver
  const outOfOrder = { ...packument, "dist-tags": {}, time: { "0.1.0": "2027-01-01T00:00:00Z", "0.2.0": "2026-10-01T00:00:00Z" } };
  assert.equal(npmPluginFromPackument(outOfOrder, { name: "@oh-summy/dsh-remote" }).author, "early");
});

test("cli: duplicate catalog names fail loudly with both line numbers (no silent drop)", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "dsh-cli-dup-"));
  const catalog = join(dir, "entries.jsonl");
  const line = JSON.stringify({ kind: "git", name: "@x/dup", repo: "https://github.com/x/dup", ref: "v1", pinnedCommit: "a".repeat(40) }) + "\n";
  writeFileSync(catalog, line + line);
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, "build", "generate.mjs")], { env: { ...process.env, DRY_RUN: "1", CATALOG_PATH: catalog } }, (err, stdout, stderr) => {
      try {
        assert.ok(err, "expected non-zero exit for duplicate plugin names");
        assert.match(String(stderr), /duplicate plugin name/);
        assert.match(String(stderr), /line 2/);
        assert.match(String(stderr), /line 1/);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test("withMeta: no meta -> no metadata group", () => {
  const pl = withMeta({ name: "x", versions: [] }, {});
  assert.equal(pl.metadata, undefined);
  assert.equal(pl.title, undefined);
});

test("cli: invalid JSON reports the ORIGINAL line number (blank lines do not shift it)", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "dsh-cli-json-"));
  const catalog = join(dir, "entries.jsonl");
  const good = JSON.stringify({ kind: "git", name: "@x/a", repo: "https://github.com/x/a", ref: "v1", pinnedCommit: "a".repeat(40) }) + "\n";
  writeFileSync(catalog, good + "\n" + "NOT JSON\n");
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, "build", "generate.mjs")], { env: { ...process.env, DRY_RUN: "1", CATALOG_PATH: catalog } }, (err, stdout, stderr) => {
      try {
        assert.ok(err, "expected non-zero exit for invalid JSON");
        assert.match(String(stderr), /line 3 is not valid JSON/);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test("cli: unknown kind fails with the catalog line number", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "dsh-cli-kind-"));
  const catalog = join(dir, "entries.jsonl");
  writeFileSync(catalog, '{"kind":"weird","name":"@x/b"}\n');
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, "build", "generate.mjs")], { env: { ...process.env, DRY_RUN: "1", CATALOG_PATH: catalog } }, (err, stdout, stderr) => {
      try {
        assert.ok(err, "expected non-zero exit for unknown kind");
        assert.match(String(stderr), /line 1/);
        assert.match(String(stderr), /unknown kind/);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test("cli: DRY_RUN happy path - version is always 0.0.0-dry (distTags.latest does not leak)", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "dsh-cli-dry-"));
  const catalog = join(dir, "entries.jsonl");
  const out = join(dir, "out");
  writeFileSync(catalog, JSON.stringify({ kind: "git", name: "@x/a", repo: "https://github.com/x/a", ref: "v1", pinnedCommit: "a".repeat(40), distTags: { latest: "9.9.9" } }) + "\n");
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, "build", "generate.mjs")], { env: { ...process.env, DRY_RUN: "1", CATALOG_PATH: catalog, OUT_PATH: out } }, (err, stdout, stderr) => {
      try {
        assert.equal(err, null, "dry-run should succeed: " + String(stderr));
        const doc = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
        assert.equal(doc.plugins[0].versions[0].version, "0.0.0-dry");
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test("validate.mjs: unparseable file exits 1 with a friendly INVALID index message", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "dsh-val-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "nope");
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, "build", "validate.mjs"), bad], (err, stdout, stderr) => {
      try {
        assert.ok(err, "expected non-zero exit");
        assert.match(String(stderr), /INVALID index/);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test("withMeta: category-only meta -> metadata with empty keywords/labels", () => {
  const pl = withMeta({ name: "x", versions: [] }, { name: "x", meta: { category: "tools" } });
  assert.deepEqual(pl.metadata, { category: "tools", keywords: [], labels: [] });
});

test("withMeta: unknown meta field fails loudly (no silent drop)", () => {
  assert.throws(() => withMeta({ name: "x", versions: [] }, { name: "x", meta: { titel: "typo" } }), /unknown meta field/);
});
