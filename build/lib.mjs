// build/lib.mjs — pure, offline-testable core of the format-1 generator (AGENTS.md §1.3 obligations).
// CLI entry: build/generate.mjs (thin wrapper; adds catalog line context to every error).
// NOTE: string ops only, no regex (keeps this file trivially reviewable).
export const MARKET = {
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
      // sortKeys (stars/downloads) are P3 — curation order = catalog line order in the meantime.
    }
  }
};

const GH = "https://github.com/";

// canonical github repo URL (https, owner/name, optional .git / trailing slash) -> { owner, repoName } | null
export function splitRepo(repoUrl) {
  const s = String(repoUrl || "");
  if (s.indexOf(GH) !== 0) return null;
  let rest = s.slice(GH.length);
  while (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest.endsWith(".git")) rest = rest.slice(0, -4);
  while (rest.endsWith("/")) rest = rest.slice(0, -1);
  const parts = rest.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repoName: parts[1] };
}

export function normalizeRepoUrl(repoUrl) {
  const r = splitRepo(repoUrl);
  return r ? GH + r.owner + "/" + r.repoName : null;
}

// tag-pinning invariant (reviewer Q2: block same-name tag force-move silent drift)
export function checkPin(entry, resolvedSha) {
  if (!entry.pinnedCommit) {
    throw new Error('missing pinnedCommit — add the entry without it, run "npm run pin", then commit the filled-in line');
  }
  if (entry.pinnedCommit !== resolvedSha) {
    throw new Error('ref "' + entry.ref + '" now resolves to ' + resolvedSha.slice(0, 12) + "... but pinnedCommit is " +
      entry.pinnedCommit.slice(0, 12) + "... — the tag moved. If deliberate, update pinnedCommit and commit; otherwise restore the upstream tag.");
  }
}

// git source: manifest read AT the pinned commit; format-1 generator obligations enforced here.
export function gitPluginFromManifest(manifest, entry, commit, ts) {
  if (!manifest.name || !manifest.version) throw new Error("manifest lacks name/version");
  if (manifest.name !== entry.name) {
    throw new Error('catalog name "' + entry.name + '" != manifest name "' + manifest.name + '" — fix the catalog line (name must equal the installed manifest)');
  }
  if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch) throw new Error(manifest.name + " does not declare dsh.bundle — not a DSH bundle");
  const enginesDsh = manifest.engines && manifest.engines.dsh;
  if (!enginesDsh) throw new Error(manifest.name + "@" + manifest.version + " has no engines.dsh — ask the author to declare it (verbatim copy is the format-1 obligation)");
  let p = entry.path || "";
  while (p.startsWith("/")) p = p.slice(1);
  while (p.endsWith("/")) p = p.slice(0, -1);
  const source = { type: "git", url: normalizeRepoUrl(entry.repo), commit: commit };
  if (p) source.path = p;
  const plugin = { name: manifest.name, versions: [{ version: manifest.version, publishTimestamp: ts, source: source, engines: { dsh: enginesDsh } }] };
  if (entry.distTags) plugin["dist-tags"] = entry.distTags;
  return withMeta(plugin, entry);
}

// npm source: every eligible published version (not deprecated, declares dsh.bundle + engines.dsh).
export function npmPluginFromPackument(d, entry) {
  const versions = [];
  for (const [v, ver] of Object.entries(d.versions || {})) {
    if (ver.deprecated) continue;
    if (!ver.dsh || !ver.dsh.bundle || !ver.dsh.bundle.patch) continue;
    const enginesDsh = ver.engines && ver.engines.dsh;
    if (!enginesDsh) { console.warn("warn: " + entry.name + "@" + v + " lacks engines.dsh — version omitted"); continue; }
    const t = d.time && d.time[v] ? d.time[v] : 0;
    versions.push({ version: v, publishTimestamp: Math.floor(new Date(t).getTime() / 1000), source: { type: "npm", ...(entry.registry ? { registry: entry.registry } : {}) }, engines: { dsh: enginesDsh } });
  }
  if (!versions.length) throw new Error(entry.name + ": no eligible versions (needs dsh.bundle + engines.dsh, not deprecated)");
  const lastV = versions[versions.length - 1].version;
  const plugin = { name: entry.name, versions: versions };
  const top = d.versions[lastV];
  if (top && top.author && top.author.name) plugin.author = top.author.name;
  if (d["dist-tags"]) {
    const eligible = new Set(versions.map((x) => x.version));
    const tags = Object.fromEntries(Object.entries(d["dist-tags"]).filter(([, tv]) => eligible.has(tv)));
    if (Object.keys(tags).length) plugin["dist-tags"] = tags;
  }
  return withMeta(plugin, entry);
}

export function withMeta(p, entry) {
  const m = entry.meta || {};
  for (const k of ["title", "description", "icon", "author", "homepage", "repository"]) if (m[k]) p[k] = m[k];
  if (m.category || m.labels || m.keywords) {
    p.metadata = {
      ...(m.category ? { category: m.category } : {}),
      keywords: m.keywords || [],
      labels: m.labels || []
    };
  }
  return p;
}
