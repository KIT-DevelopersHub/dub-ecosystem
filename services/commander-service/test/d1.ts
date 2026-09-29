// Real in-memory SQLite adapter exposing the subset of D1Database used by repo.ts.
// Runs the ACTUAL commander migration (CHECK constraints + indexes) so the phase-gate
// persistence is tested against the real schema, not a mock.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

// Apply every commander migration (0001 init + later additive ones like the P1-2 URL
// columns) in filename order, so tests run against the real, current schema.
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../infra/d1/migrations/commander",
);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function makeD1(): { d1: D1Database; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) raw.exec(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));

  const adapter = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      let args: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          args = b.map(norm);
          return api;
        },
        first<T>(): T | null {
          return (stmt.get(...(args as never[])) ?? null) as T | null;
        },
        all<T>() {
          return { results: stmt.all(...(args as never[])) as T[], success: true, meta: {} };
        },
        run() {
          const r = stmt.run(...(args as never[]));
          return {
            success: true,
            meta: {
              changes: Number(r.changes),
              last_row_id: Number(r.lastInsertRowid),
              duration: 0,
            },
          };
        },
      };
      return api;
    },
    batch(stmts: Array<{ run: () => unknown }>) {
      return stmts.map((s) => s.run());
    },
  } as unknown as D1Database;

  return { d1: adapter, raw };
}
