// Bring a STAGING D1 up to main's migrations (staging-schema-sync.yml runs it every morning).
// CI never applies migrations, so each new one on main left staging/staging2 behind and the
// D1 schema gate then failed the next staging deploy.
//
// Loop: read-only verify -> nextSchemaFix picks ONE file that fills a missing table/column
// and is safe to re-run -> `wrangler d1 execute --file` -> verify again. Exits 1 when
// something needs a human (destructive file, nothing adds the missing column, ...).
//
//   node --import tsx scripts/sync-staging-schema.ts dub-core-staging2
//   ... --dry-run   (print the plan's first step only, write nothing)
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectMigrations, MIGRATIONS_DIR } from "../src/collect";
import { remoteD1 } from "../src/remote-d1";
import { nextSchemaFix } from "../src/schema-sync";
import { verifySchema } from "../src/verify-schema";

// Staging only. Production keeps its reviewed, by-hand migration step.
const STAGING_DB = /^dub-core-staging\d*$/;
const MAX_STEPS = 50;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const db = argv.find((a) => !a.startsWith("--"));
  const dryRun = argv.includes("--dry-run");
  if (!db || !STAGING_DB.test(db)) {
    console.error(`usage: sync-staging-schema.ts <dub-core-staging|dub-core-staging2> [--dry-run] (got "${db ?? ""}")`);
    process.exit(2);
  }

  const bin = (process.env.WRANGLER_BIN ?? "wrangler").trim().split(/\s+/);
  const migrations = collectMigrations();
  const applied: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await verifySchema(remoteD1(db), migrations, { readOnly: true });
    const tables = res.missingTables.filter((t) => t !== "dub_migrations");
    const fix = nextSchemaFix(migrations, tables, res.missingColumns);

    if (fix === null) {
      console.log(`${db}: in sync with main (applied: ${applied.join(", ") || "none"})`);
      return;
    }
    if (fix.kind === "blocked") {
      console.log(`::error title=staging schema sync (${db})::${fix.reason}`);
      process.exit(1);
    }

    const name = `${fix.migration.namespace}/${fix.migration.id}`;
    if (applied.includes(name)) {
      console.log(`::error title=staging schema sync (${db})::${name} was applied but did not fill the gap`);
      process.exit(1);
    }
    if (dryRun) {
      console.log(`${db}: would apply ${name} (missing: ${[...tables, ...res.missingColumns].join(", ")})`);
      return;
    }

    console.log(`${db}: applying ${name}`);
    const file = join(MIGRATIONS_DIR, fix.migration.namespace, `${fix.migration.id}.sql`);
    const proc = spawnSync(
      bin[0]!,
      [...bin.slice(1), "d1", "execute", db, "--remote", "--yes", "--file", file],
      { cwd: tmpdir(), stdio: "inherit", env: process.env },
    );
    if (proc.status !== 0) {
      console.log(`::error title=staging schema sync (${db})::wrangler failed applying ${name}`);
      process.exit(1);
    }
    applied.push(name);
  }
  console.log(`::error title=staging schema sync (${db})::gave up after ${MAX_STEPS} steps`);
  process.exit(1);
}

void main();
