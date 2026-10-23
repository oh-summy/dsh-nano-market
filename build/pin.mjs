#!/usr/bin/env node
// build/pin.mjs — first-time registration helper: resolve each git entry's ref to its current commit
// and write pinnedCommit back into catalog/entries.jsonl (commit entry + pin together).
// After pinning, every build verifies ref resolution == pinnedCommit; a moved tag fails the build (AGENTS.md §4).
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitRepo } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = process.env.CATALOG_PATH || join(root, "catalog/entries.jsonl");
const raw = readFileSync(CATALOG, "utf8");
const lines = raw.split("\n");
const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (!l) { out.push(""); continue; }
  const entry = JSON.parse(l);
  if (entry.kind !== "git") { out.push(l); continue; }
  const rr = splitRepo(entry.repo);
  if (!rr) throw new Error("line " + (i + 1) + ": repo is not a canonical https GitHub URL");
  const ref = entry.ref || "main";
  const r = await fetch("https://api.github.com/repos/" + rr.owner + "/" + rr.repoName + "/commits/" + encodeURIComponent(ref), { headers: { "User-Agent": "dsh-nano-market-pin" } });
  if (!r.ok) throw new Error('line ' + (i + 1) + ': cannot resolve ref "' + ref + '" (HTTP ' + r.status + ")");
  const c = await r.json();
  if (entry.pinnedCommit && entry.pinnedCommit !== c.sha) {
    console.log("line " + (i + 1) + " " + entry.name + ": pin CHANGED " + entry.pinnedCommit.slice(0, 12) + " -> " + c.sha.slice(0, 12) + " (deliberate tag update - note it in the commit message)");
  } else if (!entry.pinnedCommit) {
    console.log("line " + (i + 1) + " " + entry.name + ": pinned " + ref + " -> " + c.sha.slice(0, 12));
  }
  const ordered = {};
  for (const k of ["kind", "name", "repo", "path", "ref", "pinnedCommit", "registry", "distTags", "meta"]) if (entry[k] !== undefined) ordered[k] = entry[k];
  for (const k of Object.keys(entry)) if (!(k in ordered)) ordered[k] = entry[k];
  ordered.pinnedCommit = c.sha;
  out.push(JSON.stringify(ordered));
}
writeFileSync(CATALOG, out.join("\n") + (raw.endsWith("\n") ? "\n" : ""));
console.log(CATALOG + " updated - review the diff, then commit the entry and its pin together.");
