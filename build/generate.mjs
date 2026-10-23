#!/usr/bin/env node
// build/generate.mjs — thin CLI over build/lib.mjs: catalog/entries.jsonl -> dist/index.json (format 1).
// Every error carries the catalog line number (AGENTS.md §3). String ops only: no regex, no template literals.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKET, splitRepo, normalizeRepoUrl, checkPin, gitPluginFromManifest, npmPluginFromPackument } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.env.DRY_RUN === "1";
const CATALOG = process.env.CATALOG_PATH || join(root, "catalog/entries.jsonl");
const OUT = join(root, "dist");
const UA = { "User-Agent": "dsh-nano-market-build", "Accept": "application/vnd.github+json" };

function ghJson(url) {
  return fetch(url, { headers: UA }).then((r) => {
    if (!r.ok) throw new Error("GitHub API " + r.status + " for " + url);
    return r.json();
  });
}

function where(entry, lineNo) {
  let s = "entries.jsonl line " + lineNo + ' (name "' + entry.name + '"';
  if (entry.repo) s += ", repo " + entry.repo;
  return s + ")";
}

function cleanPath(p) {
  let x = String(p || "");
  while (x.startsWith("/")) x = x.slice(1);
  while (x.endsWith("/")) x = x.slice(0, -1);
  return x;
}

async function buildEntry(entry, lineNo) {
  if (entry.kind === "git") {
    const rr = splitRepo(entry.repo);
    if (!rr) throw new Error("repo must be a canonical https GitHub URL - got " + entry.repo);
    const ref = entry.ref || "main";
    const p = cleanPath(entry.path);
    if (DRY) {
      const commit = entry.pinnedCommit || "0".repeat(40);
      if (!entry.pinnedCommit) console.warn("dry-run: " + where(entry, lineNo) + " has no pinnedCommit - placeholder commit (run npm run pin)");
      const source = { type: "git", url: normalizeRepoUrl(entry.repo), commit: commit };
      if (p) source.path = p;
      return { name: entry.name, versions: [{ version: (entry.distTags && entry.distTags.latest) || "0.0.0-dry", publishTimestamp: 0, source: source, engines: { dsh: "*" } }] };
    }
    const c = await ghJson("https://api.github.com/repos/" + rr.owner + "/" + rr.repoName + "/commits/" + encodeURIComponent(ref));
    const commit = c.sha;
    const ts = Math.floor(new Date(c.commit.committer.date).getTime() / 1000);
    checkPin(entry, commit); // tag drift fails loudly (reviewer Q2)
    const mr = await fetch("https://raw.githubusercontent.com/" + rr.owner + "/" + rr.repoName + "/" + commit + (p ? "/" + p : "") + "/package.json", { headers: UA });
    if (!mr.ok) throw new Error("manifest missing at " + rr.owner + "/" + rr.repoName + "@" + commit.slice(0, 7) + (p ? "/" + p : "") + " (HTTP " + mr.status + ") - entry rejected, no silent skip");
    return gitPluginFromManifest(await mr.json(), entry, commit, ts);
  }
  if (entry.kind === "npm") {
    const r = await fetch("https://registry.npmjs.org/" + encodeURIComponent(entry.name), { headers: UA });
    if (!r.ok) throw new Error("npm registry " + r.status + " for " + entry.name);
    return npmPluginFromPackument(await r.json(), entry);
  }
  if (entry.kind === "local") { console.warn("warn: " + where(entry, lineNo) + " is dev-only - skipped"); return null; }
  throw new Error("unknown kind: " + entry.kind);
}

const raw = readFileSync(CATALOG, "utf8");
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
const plugins = [];
for (let i = 0; i < lines.length; i++) {
  let entry;
  try { entry = JSON.parse(lines[i]); } catch (e) { throw new Error("entries.jsonl line " + (i + 1) + " is not valid JSON: " + e.message); }
  let pl;
  try { pl = await buildEntry(entry, i + 1); } catch (e) { throw new Error(where(entry, i + 1) + ": " + e.message); }
  if (pl) plugins.push(pl);
}
const seen = new Set();
const doc = Object.assign({}, MARKET, {
  generatedAt: Math.floor(Date.now() / 1000),
  plugins: plugins.filter((x) => !seen.has(x.name) && seen.add(x.name))
  // market version = git tag only (AGENTS.md §8); the index carries no version claim of its own.
});
mkdirSync(join(OUT, "icons"), { recursive: true });
const iconDir = join(root, "catalog/icons");
if (existsSync(iconDir)) for (const f of readdirSync(iconDir)) if (f !== ".gitkeep") copyFileSync(join(iconDir, f), join(OUT, "icons", f));
writeFileSync(join(OUT, "index.json"), JSON.stringify(doc, null, 2) + "\n");
console.log("dist/index.json written: " + doc.plugins.length + " plugin(s)" + (DRY ? " [dry-run]" : ""));
