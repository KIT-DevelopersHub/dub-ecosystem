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
// Notification COPY: the reader-facing headline comes from the PR body's 1st line (通知文言),
// not the raw title. Pass it via --notify-line, or let this script fetch it from the PR body
// (GitHub API via `gh pr view <pr> --json body`) when --pr is given. When the change is
// user-irrelevant (docs/chore/…) AND has no notify line, the notification is SKIPPED.
//
// Idempotent: dedupKey=deploy:<sha> + INSERT OR IGNORE, so re-running the same deploy is a
// no-op. See infra/d1/src/adminNotify.ts for the rationale (direct D1 write vs endpoint).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeployNotifyRow, buildInsertNotificationSql, shouldNotifyDeploy, type DeployNotifyMeta } from "../src/adminNotify";
import { extractNotifyLine } from "../src/deployCopy";

const WRANGLER = ["dlx", "wrangler@4.35.0"]; // matches infra/deploy/deploy-prod.sh
const D1_NAME = "dub-core";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** Fetch a PR body via the GitHub CLI (GitHub API). Returns undefined on any failure so the
 *  notify line simply falls back to title humanization — never blocks the deploy notify. */
function fetchPrBody(pr: string): string | undefined {
  const repo = flag("repo") ?? process.env.GITHUB_REPOSITORY ?? "KIT-DevelopersHub/dub-ecosystem";
  try {
    const out = execFileSync("gh", ["pr", "view", pr, "--repo", repo, "--json", "body", "-q", ".body"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return out;
  } catch (e) {
    console.warn(`admin-notify: could not fetch PR #${pr} body (${e instanceof Error ? e.message : e}); using title fallback`);
    return undefined;
  }
}

function main(): void {
  const sha = flag("sha") ?? process.env.GITHUB_SHA;
  if (!sha) {
    console.error("admin-notify: --sha (or GITHUB_SHA) is required");
    process.exit(2);
  }
  const pr = flag("pr");
  // Notify line: explicit --notify-line wins; else derive from the PR body (GitHub API).
  const notifyLine = flag("notify-line") ?? (pr ? extractNotifyLine(fetchPrBody(pr)) : undefined);
  const meta: DeployNotifyMeta = {
    sha,
    ...(flag("title") ? { title: flag("title") } : {}),
    ...(notifyLine ? { notifyLine } : {}),
    ...(pr ? { prNumber: Number(pr) } : {}),
    ...(flag("url") ? { url: flag("url") } : {}),
    ...(flag("services") ? { services: flag("services") } : {}),
    ...(flag("ref") ?? process.env.GITHUB_REF ? { ref: flag("ref") ?? process.env.GITHUB_REF } : {}),
    ...(flag("timestamp") ? { timestamp: flag("timestamp") } : {}),
  };

  // User-irrelevant deploy (docs/chore/…) with no human notify line → skip (no inbox noise).
  if (!shouldNotifyDeploy(meta)) {
    console.log(`admin-notify: SKIP — user-irrelevant change (title="${meta.title ?? ""}") with no 通知文言; no notification recorded.`);
    return;
  }
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
