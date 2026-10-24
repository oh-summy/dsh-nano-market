# dsh-nano-market

[English](README.md) | [中文](README.zh-CN.md)

**oh-summy's DSH nano-market** — a personal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin market: one curated catalog, one strictly-validated [index format 1](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)
document, hosted on GitHub Pages, consumed by DSH's native **Discover** tab. No second UI, no
second install path — browsing, searching, and installing all happen inside DSH.

> Honest cost disclosure: at P1 scale the minimum real need is a single install command
> (dsh plugin add git+https://…#<commit>&path:/<dir>). The market mechanism (index, CI,
> Pages) exists because this repo is also intended as a reference sample of a small, mature,
> well-engineered plugin market — the mechanism is part of the point.

## Quick start (3 lines)

1. **What this is**: a curated DSH plugin market you can browse in DSH's native Discover tab.
2. **One-time enable**: dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle
   then add this index in Discover (10-second official flow) — or pre-configure your profile
   (no separate config files in this repo, by design):
   代码块 yaml：
   entries:
     - id: plugin-market
       service: "@deepseek-ai/dsh-plugin-market"
       config:
         indexes: ["https://oh-summy.github.io/dsh-nano-market/index.json"]
3. **Install anything** from any source via the native confirmation flow. Whether to install a
   plugin is always your call; this market curates and distributes, it does not replace your judgment.

## Adding a plugin (paste-a-GitHub-URL = registration)

Listing in Discover **is** registration: a plugin only appears when a catalog line exists, passes
CI, and lands in main. Code without registration is never visible.

1. License check — **no LICENSE file = no go** (redline 1, AGENTS.md).
2. Find the directory whose package.json declares dsh.bundle; that manifest must declare engines.dsh.
3. Add one JSON line to catalog/entries.jsonl (schema: catalog/schema.json) — initially WITHOUT
   pinnedCommit, e.g.:
   代码块 json：
   {"kind":"git","name":"@oh-summy/dsh-<short>","repo":"https://github.com/owner/repo","path":"plugin","ref":"v1.0.0",
    "distTags":{"latest":"0.1.0"},
    "meta":{"title":{"en":"…","zh":"…"},"description":{"en":"…","zh":"…"},"icon":"icons/…","author":"…",
            "homepage":"…","repository":{"url":"https://github.com/owner/repo","directory":"plugin"},
            "category":"infra","labels":["mine"],"keywords":["…"]}}
4. Run npm run pin — the ref is resolved once and the 40-hex commit is written back into the line.
   From then on every build verifies ref resolution == pinnedCommit; a moved tag fails the build
   until you deliberately update the pin (blocks silent content drift behind an unchanged tag name).
5. PR → CI (tests + build + official validator) → merge = registered.

Full rules, originality redline, and push discipline: **CONTRIBUTING.md** (BLOCKLIST.md is the
enforcement record for the originality redline).

## Building locally

代码块 sh：
npm install && npm run ci   # tests + build + strict format-1 validation (official validator)
npm test                    # offline golden tests for the generator core
DRY_RUN=1 npm run build     # offline smoke test (placeholder commits)

## Trust & provenance

- The index is a **market claim**: titles/authors/sources are asserted by this market, not verified
  by DSH. Every install confirmation shows the exact source (npm package + registry, or git repo +
  commit + directory); the installed manifest is the final fact.
- Git entries are commit-pinned (40-hex, tag-checked against pinnedCommit). Auditing is reproducible:
  any historical index = checkout that commit + npm run build. Market releases (market-* tags) mark
  **user-visible milestones** only — data refreshes (catalog commits) are unversioned (AGENTS.md §8,
  CHANGELOG.md).
- Default index source = this market only. [awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins)
  (MIT community registry) is a documented optional source: add its URL in Discover if you want it
  (https://dsh.works/awesome-dsh-plugins/market/index.json, exact URL — DSH refuses redirects).
  An unlicensed community index (REALOIYO/dsh-plugin-market) is **link-only** by policy: evaluate
  and add at your own risk; this market neither embeds nor endorses it.

## Development conventions

**AGENTS.md** is the single source of truth (Claude-family agents read the same file via the
claude.md pointer; it must never carry rules of its own). Registration flow and contribution
rules: **CONTRIBUTING.md**. Market's own changelog: **CHANGELOG.md**.
