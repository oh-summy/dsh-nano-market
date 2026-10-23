# dsh-nano-market

[English](README.md) | [中文](#中文说明)

**oh-summy's DSH nano-market** — a personal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin market: one curated catalog, one strictly-validated [index format 1](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)
document, hosted on GitHub Pages, consumed by DSH's native **Discover** tab. No second UI, no
second install path — browsing, searching, and installing all happen inside DSH.

## Quick start

1. In DSH's web profile, enable the experimental market bundle and pre-configure the built-in sources:

   ```sh
   dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle
   # then append install/preset.patch.yml to ~/.dsh/profiles/web/cordis.patch.yml
   # (or try without touching the profile:  dsh web --patch /path/to/install/preset.patch.yml)
   ```

2. In the Web UI: **Plugins → More (Experimental plugins) → turn on “Custom plugin markets”**.
   The **Discover** tab opens with the built-in sources already listed — browse them.
3. Install anything you like from any source via the native confirmation flow. Whether to
   install a plugin is always your call; built-in sources are browse-only defaults.

## Adding a plugin (paste-a-GitHub-URL flow)

1. Check the repo's license — **no LICENSE file = no go** (license redline, AGENTS.md §1).
2. Find the directory whose package.json declares `dsh.bundle`, and make sure that manifest
   declares `engines.dsh` (ask the author to add it if not).
3. Add one JSON line to `catalog/entries.jsonl` (schema: `catalog/schema.json`):

   ```json
   {"kind":"git","name":"@oh-summy/dsh-<short>","repo":"https://github.com/owner/repo","path":"plugin","ref":"v1.0.0",
    "distTags":{"latest":"0.1.0"},
    "meta":{"title":{"en":"…","zh":"…"},"description":{"en":"…","zh":"…"},"icon":"icons/…","author":"…",
            "homepage":"…","repository":{"url":"https://github.com/owner/repo","directory":"plugin"},
            "category":"infra","labels":["mine"],"keywords":["…"]}}
   ```

4. Open a PR — CI builds the index, resolves the ref to a pinned commit, validates it with the
   official DSH validator, and deploys to GitHub Pages on merge.

## Building locally

```sh
npm install && npm run ci        # build + strict format-1 validation
DRY_RUN=1 npm run build          # offline smoke test (no GitHub resolution)
```

## Trust & provenance

- The index is a **market claim**: titles, authors, and sources are asserted by this market, not
  verified by DSH. Every install confirmation in DSH shows the exact source (npm package +
  registry, or git repo + commit + directory); the installed manifest is the final fact.
- Git entries are commit-pinned (40-hex SHA); market releases are tag-pinned (market-vX.Y.Z
  Releases keep an auditable snapshot of every index document).
- Built-in sources: this market + [awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins)
  (MIT open-data registry). An unlicensed community index (REALOIYO/dsh-plugin-market) is
  **link-only** in this README by policy: add it in Discover at your own risk.

## 中文说明

个人 DSH 插件小市场：策展 catalog → 严格校验的 Format-1 索引 → GitHub Pages → DSH 原生 Discover。
安装走 DSH 官方确认流程；市场只策展与分发，不替代你对插件本身的判断。开发规范见 AGENTS.md。
