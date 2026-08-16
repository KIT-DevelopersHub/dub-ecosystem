#!/usr/bin/env -S node --import tsx
// One-time backfill: record an Admin notification for every PAST merged PR that never
// produced one, so historical updates also appear in the Admin inbox. Idempotent by
// dedupKey=deploy:<mergeCommitSha> (same key space as the forward CI step), so this is
// safe to re-run and never double-inserts.
//
// PREVIEW-FIRST (default): lists the delta (count + table) and writes NOTHING. Production
// D1 writes require BOTH --apply AND CLOUDFLARE_API_TOKEN (approval-gated).
//
// Usage (from infra/d1):
//   node --import tsx scripts/admin-notify-backfill.ts               # preview
//   node --import tsx scripts/admin-notify-backfill.ts --apply       # write (needs token)
//   [--repo <owner/name>] [--limit 500]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackfillRows, buildBackfillSql, deployDedupKey, type MergedPr } from "../src/adminNotify";

const WRANGLER = ["dlx", "wrangler@4.35.0"];
const D1_NAME = "dub-core";
const DEFAULT_REPO = "KIT-DevelopersHub/dub-ecosystem";

const flag = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string): boolean => process.argv.includes(`--${n}`);

function listMergedPrs(repo: string, limit: number): MergedPr[] {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit), "--json", "number,title,url,mergedAt,mergeCommit"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out) as MergedPr[];
}

/** Existing deploy:* dedup keys already in prod D1 (remote read; needs token). Empty when
 *  we cannot query (preview without a token) — then every merged PR shows as a candidate. */
function existingDedupKeys(): Set<string> {
  if (!process.env.CLOUDFLARE_API_TOKEN) return new Set();
  try {
    const out = execFileSync(
      "pnpm",
      [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--json", "--command", "SELECT dedup_key FROM notif_notifications WHERE dedup_key LIKE 'deploy:%'"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out) as Array<{ results?: Array<{ dedup_key: string }> }>;
    const keys = new Set<string>();
    for (const block of parsed) for (const r of block.results ?? []) keys.add(r.dedup_key);
    return keys;
  } catch (e) {
    console.warn("warn: could not read existing dedup keys (treating all as candidates):", e instanceof Error ? e.message : e);
    return new Set();
  }
}

function main(): void {
  const repo = flag("repo") ?? DEFAULT_REPO;
  const limit = Number(flag("limit") ?? "500");
  const apply = has("apply");

  const prs = listMergedPrs(repo, limit);
  const existing = existingDedupKeys();
  const rows = buildBackfillRows(prs, existing);

  console.log(`# backfill preview — repo=${repo}`);
  console.log(`# merged PRs scanned: ${prs.length}`);
  console.log(`# already recorded (deploy:* in D1): ${existing.size}`);
  console.log(`# NEW Admin notifications to create: ${rows.length}\n`);
  console.log("PR#\tSHA(12)\tdedupKey\ttitle");
  for (const { meta } of rows) {
    console.log(`#${meta.prNumber}\t${meta.sha.slice(0, 12)}\t${deployDedupKey(meta.sha)}\t${meta.title}`);
  }

  if (!apply) {
    console.log(`\n# DRY-RUN — nothing written. Re-run with --apply (+ CLOUDFLARE_API_TOKEN) to record ${rows.length} rows.`);
    return;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error("\n--apply requires CLOUDFLARE_API_TOKEN"); process.exit(2);
  }
  if (rows.length === 0) {
    console.log("\n# nothing to backfill (already up to date)."); return;
  }
  const dir = mkdtempSync(join(tmpdir(), "admin-backfill-"));
  const file = join(dir, "backfill.sql");
  writeFileSync(file, buildBackfillSql(rows) + "\n", "utf8");
  console.log(`\n# applying ${rows.length} idempotent INSERTs to remote ${D1_NAME}...`);
  execFileSync("pnpm", [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--file", file], { stdio: "inherit" });
  console.log("# backfill done (idempotent — safe to re-run).");
}

main();
