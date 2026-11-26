// usage-escalation entrypoint (#902) — run by .github/workflows/usage-escalation.yml.
//   pnpm --filter @dub/usage-meter exec tsx scripts/usage-escalation.ts --rows rows.json [--dry-run]
// --print-sql: print the one read-only SELECT the workflow runs, then exit.
// --rows: `wrangler d1 execute dub-core --remote --json --command "<SNAPSHOT_SQL>"` output
//         (or a plain array of rows). --dry-run prints the Issues instead of posting.
// env: GH_TOKEN + GITHUB_REPOSITORY (post), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
//      (top consumers; optional — the Issue then says to run the runbook query by hand).
import { readFileSync } from "node:fs";
import { githubRest, runEscalation, SNAPSHOT_SQL, summaryFromHistory, type HistoryRow } from "../src/escalate";

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
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!dryRun && (!token || !repo)) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required (or pass --dry-run)");

  const levels = summary.services.map((s) => `${s.metricKey}=${s.level}${s.pct === null ? "" : `(${s.pct}%)`}`);
  console.log(`capturedAt=${summary.capturedAt} stale=${summary.stale} worstLevel=${summary.worstLevel}`);
  console.log(levels.join("\n"));

  const actions = await runEscalation(summary, {
    now,
    issues: dryRun ? null : githubRest({ token: token!, repo: repo! }),
    consumers: {
      token: process.env.CLOUDFLARE_API_TOKEN ?? null,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
    },
  });
  for (const a of actions) {
    if (a.action === "planned") console.log(`\n===== ${a.title}\nlabels: ${a.labels.join(", ")}\n\n${a.body}\n`);
    else console.log(JSON.stringify(a));
  }
  if (actions.length === 0) console.log(summary.stale ? "stale snapshot: no Issues" : "nothing at warn or above");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
