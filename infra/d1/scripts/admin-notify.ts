#!/usr/bin/env -S node --import tsx
// CI deploy → Admin notification. Records ONE idempotent audience='admin' notification row
// in dub-core D1 for a production deploy. Dry-run by default (prints the SQL); --apply
// writes to remote D1 via wrangler (needs CLOUDFLARE_API_TOKEN).
//
// Usage (from repo root):
//   node --import tsx infra/d1/scripts/admin-notify.ts \
//     --sha "$GITHUB_SHA" --title "<pr/commit title>" --pr 213 \
//     --url "<pr url>" --services "全Worker + fe2 + mo3" --ref "$GITHUB_REF" [--apply]
//
// Idempotent: dedupKey=deploy:<sha> + INSERT OR IGNORE, so re-running the same deploy is a
// no-op. See infra/d1/src/adminNotify.ts for the rationale (direct D1 write vs endpoint).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeployNotifyRow, buildInsertNotificationSql, type DeployNotifyMeta } from "../src/adminNotify";

const WRANGLER = ["dlx", "wrangler@4.35.0"]; // matches infra/deploy/deploy-prod.sh
const D1_NAME = "dub-core";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function main(): void {
  const sha = flag("sha") ?? process.env.GITHUB_SHA;
  if (!sha) {
    console.error("admin-notify: --sha (or GITHUB_SHA) is required");
    process.exit(2);
  }
  const meta: DeployNotifyMeta = {
    sha,
    ...(flag("title") ? { title: flag("title") } : {}),
    ...(flag("pr") ? { prNumber: Number(flag("pr")) } : {}),
    ...(flag("url") ? { url: flag("url") } : {}),
    ...(flag("services") ? { services: flag("services") } : {}),
    ...(flag("ref") ?? process.env.GITHUB_REF ? { ref: flag("ref") ?? process.env.GITHUB_REF } : {}),
    ...(flag("timestamp") ? { timestamp: flag("timestamp") } : {}),
  };
  const row = buildDeployNotifyRow(meta);
  const sql = buildInsertNotificationSql(row);

  if (!has("apply")) {
    console.log("# admin-notify DRY-RUN (pass --apply to write to remote dub-core)\n");
    console.log(`# dedupKey=${row.dedupKey}  title=${row.title}`);
    console.log(sql);
    return;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error("admin-notify --apply: CLOUDFLARE_API_TOKEN is required");
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "admin-notify-"));
  const file = join(dir, "deploy-notify.sql");
  writeFileSync(file, sql + "\n", "utf8");
  console.log(`admin-notify: applying ${row.dedupKey} (${row.title})`);
  execFileSync("pnpm", [...WRANGLER, "d1", "execute", D1_NAME, "--remote", "--file", file], {
    stdio: "inherit",
  });
  console.log("admin-notify: done (idempotent — re-runs of the same SHA are no-ops).");
}

main();
