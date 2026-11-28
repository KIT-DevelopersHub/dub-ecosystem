// usage-escalation entrypoint (#902) — run by .github/workflows/usage-escalation.yml.
//   pnpm --filter @dub/usage-meter exec tsx scripts/usage-escalation.ts --rows rows.json [--dry-run]
// --print-sql: print the one read-only SELECT the workflow runs, then exit.
// --rows: `wrangler d1 execute dub-core --remote --json --command "<SNAPSHOT_SQL>"` output
//         (or a plain array of rows). --dry-run prints the Issues instead of posting.
// env: USAGE_ALERT_GH_TOKEN (fine-grained PAT, Issues: write on the alert repo only),
//      USAGE_ALERT_REPO (owner/name, default KIT-DevelopersHub/dub-docs — private; the public
//      dub-ecosystem is refused), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (top consumers;
//      optional — the Issue then says to run the runbook query by hand).
// No token => exit 0 without filing: admins still get the Worker's in-app notice + mail.
// The CI log is public (dub-ecosystem), so it never prints usage numbers or Issue bodies.
import { readFileSync } from "node:fs";
import { isEscalated } from "../src/escalation";
import { githubRest, runEscalation, SNAPSHOT_SQL, summaryFromHistory, type HistoryRow } from "../src/escalate";
import { resolveAlertRepo } from "../src/playbook";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseRows(text: string): HistoryRow[] {
  const json = JSON.parse(text) as unknown;
  if (Array.isArray(json) && json.length > 0 && typeof json[0] === "object" && json[0] !== null && "results" in json[0]) {
    return (json as { results: HistoryRow[] }[]).flatMap((r) => r.results ?? []);
  }
  if (Array.isArray(json)) return json as HistoryRow[];
  throw new Error("--rows: expected wrangler --json output or an array of rows");
}

async function main(): Promise<void> {
  if (process.argv.includes("--print-sql")) {
    process.stdout.write(SNAPSHOT_SQL);
    return;
  }
  const rowsPath = arg("--rows");
  if (!rowsPath) throw new Error("--rows <file> is required");
  const dryRun = process.argv.includes("--dry-run");
  const now = arg("--now") ? new Date(arg("--now")!) : new Date();

  const summary = summaryFromHistory(parseRows(readFileSync(rowsPath, "utf8")), now);
  // Public Actions log: counts only. Bodies are printed only for a local --dry-run.
  const quiet = process.env.GITHUB_ACTIONS === "true";
  const escalated = summary.services.filter((s) => isEscalated(s.level)).length;
  console.log(`stale=${summary.stale} escalated=${escalated}`);

  const token = process.env.USAGE_ALERT_GH_TOKEN?.trim() || null;
  const repo = resolveAlertRepo(process.env.USAGE_ALERT_REPO);
  if (!dryRun && !repo) {
    console.log("USAGE_ALERT_REPO refused (public dub-ecosystem or not owner/name): skipped filing (in-app notice + mail continue)");
    return;
  }
  if (!dryRun && !token) {
    console.log("USAGE_ALERT_GH_TOKEN is not set: skipped filing (in-app notice + mail continue)");
    return;
  }

  const actions = await runEscalation(summary, {
    now,
    issues: dryRun ? null : githubRest({ token: token!, repo: repo! }),
    consumers: {
      token: process.env.CLOUDFLARE_API_TOKEN ?? null,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
    },
  });
  const counts: Record<string, number> = {};
  for (const a of actions) {
    counts[a.action] = (counts[a.action] ?? 0) + 1;
    if (a.action === "planned" && !quiet) console.log(`\n===== ${a.title}\nlabels: ${a.labels.join(", ")}\n\n${a.body}\n`);
  }
  console.log(`actions: ${JSON.stringify(counts)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
