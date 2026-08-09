// Real in-memory SQLite adapter exposing the subset of the D1Database interface that
// @dub/db createDbClient uses. Runs the actual audit schema (triggers included) so the
// append-only guarantees are tested authentically, not mocked.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";

// Load node:sqlite through createRequire so Vite/Vitest's transform pipeline never
// tries to resolve it as a bundleable module (it strips the "node:" and 404s).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../db/0001_audit_logs.sql");

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function makeD1(): { d1: D1Database; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(SCHEMA_PATH, "utf8"));

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
          return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
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
