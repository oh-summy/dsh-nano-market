#!/usr/bin/env node
// build/generate.mjs — catalog/entries.jsonl → dist/index.json (DSH plugin market index, format 1).
// Enforces the format-1 generator obligations (AGENTS.md §1.3). DRY_RUN=1 skips network resolution.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.env.DRY_RUN === "1";

const MARKET = {
  format: 1,
  title: { en: "oh-summy's DSH Nano Market", zh: "oh-summy 的 DSH 纳米市场" },
  description: {
    en: "A personal DSH plugin market: curated entries, commit-pinned git sources, version-traceable releases.",
    zh: "个人 DSH 插件市场：策展条目、commit 固定的 git 源、可溯源的版本发布。"
  },
  metadata: {
    categories: {
      infra: { title: { en: "Infrastructure", zh: "基础设施" } },
      workflow: { title: { en: "Workflow & Modes", zh: "工作流/模式" } },
      skills: { title: { en: "Skills", zh: "技能" } },
      tools: { title: { en: "Tools", zh: "工具" } },
      ui: { title: { en: "UI", zh: "界面" } }
    },
    labels: {
      mine: { title: { en: "by oh-summy", zh: "oh-summy 出品" } },
      experimental: { title: { en: "Experimental", zh: "实验性" } },
      notifier: { title: { en: "Notifier", zh: "通知接口" } },
      "needs-env": { title: { en: "Needs Env", zh: "需要外部凭据/服务" } },
      reference: { title: { en: "Reference", zh: "参考（外部生态）" } }
    },
    sortKeys: {
      stars: { title: { en: "Stars", zh: "Star 数" }, order: "desc" },
      downloads: { title: { en: "Downloads", zh: "下载量" }, order: "desc" }
    }
  }
};

const UA = { "User-Agent": "dsh-nano-market-build", "Accept": "application/vnd.github+json" };
async function ghJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("GitHub API " + r.status + " for " + url);
  return r.json();
}

function withMeta(p, e) {
  const m = e.meta || {};
  for (const k of ["title", "description", "icon", "author", "homepage", "repository"]) if (m[k]) p[k] = m[k];
  if (m.category || m.labels || m.keywords || m.sortKeys) {
    p.metadata = {
      ...(m.category ? { category: m.category } : {}),
      keywords: m.keywords || [],
      labels: m.labels || [],
      ...(m.sortKeys ? { sortKeys: m.sortKeys } : {})
    };
  }
  return p;
}

function splitRepo(repoUrl) {
  const parts = String(repoUrl).replace(/^https?:\/{2}/, "").replace(/^github\.com\//, "").replace(/^www\./, "").replace(/\.git$/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repoName: parts[1] };
}

// git entry: ref (tag preferred) → pinned commit; manifest read at that commit; generator obligations enforced.
async function resolveGit(e) {
  const rr = splitRepo(e.repo);
  if (!rr) throw new Error("git entry: repo must be https://github.com/OWNER/NAME — got " + e.repo);
  const { owner, repoName } = rr;
  const ref = e.ref || "main";
  const p = (e.path || "").replace(/\/+$/, "");
  const source = { type: "git", url: "https://github.com/" + owner + "/" + repoName, ...(p ? { path: p } : {}) };
  if (DRY) {
    console.warn("dry-run: git entry " + e.name + " @ " + ref + " not resolved (placeholder commit)");
    return withMeta({ name: e.name, versions: [{ version: "0.0.0-dry", publishTimestamp: 0, source: { ...source, commit: "0".repeat(40) }, engines: { dsh: "*" } }] }, e);
  }
  const c = await ghJson("https://api.github.com/repos/" + owner + "/" + repoName + "/commits/" + encodeURIComponent(ref));
  const commit = c.sha;
  const ts = Math.floor(new Date(c.commit.committer.date).getTime() / 1000);
  const mr = await fetch("https://raw.githubusercontent.com/" + owner + "/" + repoName + "/" + commit + (p ? "/" + p : "") + "/package.json", { headers: UA });
  if (!mr.ok) throw new Error("manifest missing at " + owner + "/" + repoName + "@" + commit.slice(0, 7) + (p ? "/" + p : "") + " (HTTP " + mr.status + ") — entry rejected (no silent skip)");
  const manifest = await mr.json();
  if (!manifest.name || !manifest.version) throw new Error("manifest of " + owner + "/" + repoName + "@" + commit + " lacks name/version");
  if (manifest.name !== e.name) throw new Error("catalog name " + e.name + " != manifest name " + manifest.name + " (format-1 obligation: name must equal the installed manifest)");
  if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch) throw new Error(manifest.name + " does not declare dsh.bundle — not a DSH bundle, entry rejected");
  const enginesDsh = manifest.engines && manifest.engines.dsh;
  if (!enginesDsh) throw new Error(manifest.name + "@" + manifest.version + " has no engines.dsh — add it to the manifest (format-1 obligation)");
  const plugin = { name: manifest.name, versions: [{ version: manifest.version, publishTimestamp: ts, source: { ...source, commit }, engines: { dsh: enginesDsh } }] };
  if (e.distTags) plugin["dist-tags"] = e.distTags;
  return withMeta(plugin, e);
}

// npm entry: list every eligible published version (not deprecated, declares dsh.bundle + engines.dsh).
async function resolveNpm(e) {
  const r = await fetch("https://registry.npmjs.org/" + encodeURIComponent(e.name), { headers: UA });
  if (!r.ok) throw new Error("npm " + r.status + " for " + e.name);
  const d = await r.json();
  const versions = [];
  for (const [v, ver] of Object.entries(d.versions || {})) {
    if (ver.deprecated) continue;
    if (!ver.dsh || !ver.dsh.bundle || !ver.dsh.bundle.patch) continue;
    const enginesDsh = ver.engines && ver.engines.dsh;
    if (!enginesDsh) { console.warn("warn: " + e.name + "@" + v + " lacks engines.dsh — version omitted"); continue; }
    versions.push({ version: v, publishTimestamp: Math.floor(new Date(d.time && d.time[v] ? d.time[v] : 0).getTime() / 1000), source: { type: "npm", ...(e.registry ? { registry: e.registry } : {}) }, engines: { dsh: enginesDsh } });
  }
  if (!versions.length) throw new Error(e.name + ": no eligible versions (needs dsh.bundle + engines.dsh, not deprecated)");
  const topV = versions.slice().sort((a, b) => new Date(d.time[a.version]) - new Date(d.time[b.version])).at(-1);
  const top = d.versions[topV.version];
  const plugin = { name: e.name, versions };
  if (top.author && top.author.name) plugin.author = top.author.name;
  if (d["dist-tags"]) {
    const eligible = new Set(versions.map((v) => v.version));
    const tags = Object.fromEntries(Object.entries(d["dist-tags"]).filter(([, tv]) => eligible.has(tv)));
    if (Object.keys(tags).length) plugin["dist-tags"] = tags;
  }
  return withMeta(plugin, e);
}

const raw = readFileSync(join(root, "catalog/entries.jsonl"), "utf8");
const entries = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const plugins = [];
for (const e of entries) {
  if (e.kind === "git") plugins.push(await resolveGit(e));
  else if (e.kind === "npm") plugins.push(await resolveNpm(e));
  else if (e.kind === "local") console.warn("warn: local entry " + e.name + " is dev-only, skipped in build");
  else throw new Error("unknown entry kind: " + e.kind);
}
const seen = new Set();
const doc = {
  ...MARKET,
  marketVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  generatedAt: Math.floor(Date.now() / 1000),
  plugins: plugins.filter((pl) => !seen.has(pl.name) && seen.add(pl.name))
};
mkdirSync(join(root, "dist/icons"), { recursive: true });
const iconDir = join(root, "catalog/icons");
if (existsSync(iconDir)) for (const f of readdirSync(iconDir)) { if (f !== ".gitkeep") copyFileSync(join(iconDir, f), join(root, "dist/icons", f)); }
writeFileSync(join(root, "dist/index.json"), JSON.stringify(doc, null, 2) + "\n");
console.log("dist/index.json written: " + doc.plugins.length + " plugin(s)" + (DRY ? " [dry-run: git entries unresolved]" : ""));
