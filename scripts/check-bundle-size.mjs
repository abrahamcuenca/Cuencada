#!/usr/bin/env node
/**
 * Fails when the initial JS of the web build exceeds the gzip budget.
 *
 * "Initial JS" = every script the browser fetches before the first route
 * renders: the `<script type="module">` entry plus every `<link
 * rel="modulepreload">` in `apps/web/dist/index.html`. Lazy route chunks are
 * excluded. Run after `pnpm build`:
 *
 *   pnpm --filter @cuencada/web size
 *   node scripts/check-bundle-size.mjs [distDir] [budgetKB]
 *
 * The plan's budget is 200 KB gzip; CI gates at 190 KB to keep headroom.
 * KB = 1000 bytes, matching Vite's build report.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const distDir = resolve(process.argv[2] ?? join(repoRoot, "apps/web/dist"));
const budgetKb = Number(process.argv[3] ?? 190);

if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
  process.stderr.write(`Invalid budget: ${process.argv[3]}\n`);
  process.exit(2);
}

let html;
try {
  html = readFileSync(join(distDir, "index.html"), "utf8");
} catch {
  process.stderr.write(`No build found at ${distDir}. Run "pnpm build" first.\n`);
  process.exit(2);
}

const sources = new Set();
for (const match of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) sources.add(match[1]);
for (const match of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) sources.add(match[1]);

if (sources.size === 0) {
  process.stderr.write("No entry script found in index.html.\n");
  process.exit(2);
}

let totalGzip = 0;
const rows = [];
for (const src of sources) {
  const bytes = readFileSync(join(distDir, src.replace(/^\//, "")));
  const gzip = gzipSync(bytes).length;
  totalGzip += gzip;
  rows.push(`  ${src}  ${(bytes.length / 1000).toFixed(2)} kB raw, ${(gzip / 1000).toFixed(2)} kB gzip`);
}

const totalKb = totalGzip / 1000;
process.stdout.write(`Initial JS:\n${rows.join("\n")}\n  total ${totalKb.toFixed(2)} kB gzip (budget ${budgetKb} kB)\n`);

if (totalKb > budgetKb) {
  process.stderr.write(`Initial JS is ${totalKb.toFixed(2)} kB gzip, over the ${budgetKb} kB budget. Lazy-load more.\n`);
  process.exit(1);
}
