#!/usr/bin/env node
// build/validate.mjs — strict DSH format-1 validation of an index document.
// Usage: node build/validate.mjs [dist/index.json]   (INDEX_URL env: the URL the document will be served from)
import { readFileSync } from "node:fs";
import { parseMarketIndex } from "@deepseek-ai/dsh-plugin-market-index";
const file = process.argv[2] || "dist/index.json";
const url = process.env.INDEX_URL || "https://oh-summy.github.io/dsh-nano-market/index.json";
const doc = JSON.parse(readFileSync(file, "utf8"));
try {
  const idx = parseMarketIndex(doc, url);
  console.log("OK: valid format-1 index — " + idx.plugins.length + " plugin(s), title=" + JSON.stringify(idx.title.en));
} catch (err) {
  console.error("INVALID index: " + err.message + (err.path ? " (path: " + err.path + ")" : "") + " — the whole document would be refused by DSH readers; fix the generator");
  process.exit(1);
}
