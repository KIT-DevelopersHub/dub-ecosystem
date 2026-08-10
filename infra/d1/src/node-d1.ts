// A node:sqlite-backed adapter exposing the subset of D1Database this unit uses
// (prepare/bind/first/all/run, exec, batch). Node-only tooling — NEVER bundled into a
// Worker. node:sqlite is loaded via createRequire so Vitest/Vite's transform never
// tries to resolve the "node:" specifier as a bundleable module.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

type Raw = InstanceType<typeof DatabaseSync>;

function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  return v;
}

export function wrapD1(raw: Raw): D1Database {
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
    exec(sql: string) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch(stmts: Array<{ run: () => unknown }>) {
      return stmts.map((s) => s.run());
    },
  } as unknown as D1Database;
  return adapter;
}

/** In-memory D1 (tests). */
export function memoryD1(): { db: D1Database; raw: Raw } {
  const raw = new DatabaseSync(":memory:");
  return { db: wrapD1(raw), raw };
}

/** File-backed D1 (local dev / scripts). Creates the parent dir (e.g. .wrangler/) so a
 *  fresh checkout can `pnpm db:reset` without a manual mkdir. Skipped for ":memory:". */
export function fileD1(path: string): { db: D1Database; raw: Raw } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  return { db: wrapD1(raw), raw };
}
