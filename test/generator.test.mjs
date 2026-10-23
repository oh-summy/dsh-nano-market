// test/generator.test.mjs — offline golden tests for the generator core (node:test).
// The "fail loudly, no silent skip" promise (AGENTS.md §1.3) must be proven, not asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRepo, normalizeRepoUrl, checkPin, gitPluginFromManifest, npmPluginFromPackument, withMeta } from "../build/lib.mjs";

const validManifest = {
  name: "@oh-summy/dsh-remote",
  version: "0.1.0",
  engines: { dsh: ">=0.2.1-rc.2" },
  dsh: { bundle: { patch: "./cordis.patch.yml" } }
};
const validEntry = {
  kind: "git", name: "@oh-summy/dsh-remote",
  repo: "https://github.com/oh-summy/dsh-remote-control",
  path: "plugin", ref: "v0.4.0", pinnedCommit: "b".repeat(40),
  meta: { title: { en: "Remote Control", zh: "远程接入" }, category: "infra", labels: ["mine"], keywords: ["remote"] }
};
const COMMIT = "c".repeat(40);

test("splitRepo: canonical github urls", () => {
  assert.deepEqual(splitRepo("https://github.com/oh-summy/dsh-remote-control"), { owner: "oh-summy", repoName: "dsh-remote-control" });
  assert.deepEqual(splitRepo("https://github.com/oh-summy/dsh-remote-control.git"), { owner: "oh-summy", repoName: "dsh-remote-control" });
  assert.deepEqual(splitRepo("https://github.com/oh-summy/dsh-remote-control.git/"), { owner: "oh-summy", repoName: "dsh-remote-control" });
  assert.equal(splitRepo("git@github.com:oh-summy/dsh-remote-control.git"), null);
  assert.equal(splitRepo("https://github.com/oh-summy"), null);
  assert.equal(splitRepo("https://gitlab.com/oh-summy/x"), null);
});

test("normalizeRepoUrl: canonical form", () => {
  assert.equal(normalizeRepoUrl("https://github.com/oh-summy/dsh-remote-control.git/"), "https://github.com/oh-summy/dsh-remote-control");
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
  assert.equal(v.source.url, "https://github.com/oh-summy/dsh-remote-control");
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

test("withMeta: no meta -> no metadata group", () => {
  const pl = withMeta({ name: "x", versions: [] }, {});
  assert.equal(pl.metadata, undefined);
  assert.equal(pl.title, undefined);
});
