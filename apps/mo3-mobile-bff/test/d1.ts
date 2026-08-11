// Real in-memory SQLite adapter exposing the subset of D1Database the @dub/freeq
// outbox uses, seeded with the outbox DDL — so the free-tier drain (enqueue INSERT,
// status/next_attempt_at query, done/retry UPDATEs) is exercised authentically, not
// mocked. Mirrors packages/freeq/test/d1.ts.
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";
import { OUTBOX_DDL } from "@dub/freeq";

// Load node:sqlite through createRequire so Vitest's transform pipeline never tries to
// resolve it as a bundleable module (it strips the "node:" prefix and 404s).
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function makeD1(): { d1: D1Database; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(OUTBOX_DDL);

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
