// dev:seed — initialise the LOCAL miniflare D1 (`dub-core`) that `wrangler dev`
// services read, with the full forward-only migration set + a demo seed scenario.
//
// Why this exists: `pnpm db:seed` (infra/d1) writes to its OWN node:sqlite file
// (.wrangler/local-dub-core.sqlite) — a fast path for infra tests. The Workers you run
// with `wrangler dev` do NOT read that file; they read miniflare's local D1 under the
// shared persist dir. This script bridges the gap: it re-uses the exact infra/d1
// migration (`applyAll`) + seed (`seedScenario`) logic through a SQL-recording D1
// adapter, emits one deterministic .sql file, and loads it into miniflare's local
// `dub-core` for every service that binds it — so the running Workers see the demo data.
//
// Usage:  node --import tsx scripts/local/seed-local.ts [--scenario conference-demo]
//         (exposed as `pnpm dev:seed`)
//
// Safe & local-only: it targets miniflare's local store under <repo>/.wrangler-local
// and never touches any remote/production D1.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { applyAll } from "../../infra/d1/src/apply";
import { seedScenario, type SeedScenarioName } from "../../infra/d1/seed/scenarios";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PERSIST_DIR = join(REPO_ROOT, ".wrangler-local");
const SQL_PATH = join(PERSIST_DIR, "seed.sql");
const WRANGLER = join(REPO_ROOT, "node_modules", ".bin", "wrangler");

// Every service whose wrangler.toml binds the shared `dub-core` D1. Each gets its own
// local store under PERSIST_DIR (keyed by its database_id), so we apply the SQL once per
// service. Namespace isolation means the extra tables are simply unused per service.
const DUB_CORE_SERVICES = ["services/identity-roster", "services/mail-gateway"] as const;

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Inline bound params (`?`) into a statement so it can live in a portable .sql file. */
function inline(sql: string, args: readonly unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => sqlLiteral(args[i++]));
}

/** A write-only D1 adapter that records every executed statement as SQL text instead of
 *  touching a database. Reads return "empty" so applyAll treats every migration as
 *  pending and emits it. */
function recordingD1(sink: string[]): D1Database {
  const adapter = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          args = b;
          return api;
        },
        first<T>(): T | null {
          return null;
        },
        all<T>() {
          return { results: [] as T[], success: true, meta: {} };
        },
        run() {
          sink.push(inline(sql, args).trim().replace(/;?\s*$/, "") + ";");
          return { success: true, meta: { changes: 0, last_row_id: 0, duration: 0 } };
        },
      };
      return api;
    },
    exec(sql: string) {
      sink.push(sql.trim().replace(/;?\s*$/, "") + ";");
      return { count: 0, duration: 0 };
    },
    batch(stmts: Array<{ run: () => unknown }>) {
      return stmts.map((s) => s.run());
    },
  } as unknown as D1Database;
  return adapter;
}

function parseScenario(argv: string[]): SeedScenarioName {
  const i = argv.indexOf("--scenario");
  return (i >= 0 && argv[i + 1] ? argv[i + 1] : "conference-demo") as SeedScenarioName;
}

async function buildSql(scenario: SeedScenarioName): Promise<string> {
  const statements: string[] = [];
  const db = recordingD1(statements);
  await applyAll(db); // ledger DDL + every migration `up` + ledger inserts
  // databaseName is a local sentinel (never "dub-core") so the prod-seed guard passes.
  await seedScenario(db, scenario, { databaseName: `local:${PERSIST_DIR}` });
  return statements.join("\n") + "\n";
}

function applyToService(serviceDir: string): void {
  const cwd = join(REPO_ROOT, serviceDir);
  const res = spawnSync(
    WRANGLER,
    ["d1", "execute", "dub-core", "--local", `--persist-to=${PERSIST_DIR}`, `--file=${SQL_PATH}`, "--yes"],
    { cwd, stdio: "inherit", env: process.env },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute failed for ${serviceDir} (exit ${res.status ?? "signal " + res.signal})`);
  }
}

async function main(): Promise<void> {
  const scenario = parseScenario(process.argv.slice(2));
  if (!existsSync(WRANGLER)) {
    throw new Error(`wrangler not found at ${WRANGLER} — run \`pnpm install\` first.`);
  }

  // Clean slate: remove the whole local store so migrations (plain CREATE TABLE) apply
  // without "table already exists". Local-only — never a remote DB.
  console.log(`[dev:seed] resetting local store ${PERSIST_DIR}`);
  rmSync(PERSIST_DIR, { recursive: true, force: true });
  mkdirSync(PERSIST_DIR, { recursive: true });

  console.log(`[dev:seed] building SQL (scenario: ${scenario})`);
  const sql = await buildSql(scenario);
  writeFileSync(SQL_PATH, sql, "utf8");
  console.log(`[dev:seed] wrote ${SQL_PATH} (${sql.split("\n").length} lines)`);

  for (const svc of DUB_CORE_SERVICES) {
    console.log(`[dev:seed] applying to ${svc} (local dub-core)`);
    applyToService(svc);
  }
  console.log("[dev:seed] done — start services with `pnpm dev:identity` / `dev:auth` / `dev:gateway` / `dev:mail`.");
}

void main().catch((err) => {
  console.error("[dev:seed] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
