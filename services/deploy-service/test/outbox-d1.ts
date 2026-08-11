// Real in-memory SQLite adapter for the free-tier outbox, seeded with @dub/freeq's
// OUTBOX_DDL so the outbox shim + runOutboxDrain run against authentic D1 SQL (INSERT OR
// IGNORE, the status/next_attempt_at drain query, the status UPDATEs) — not a mock.
// Mirrors services/auth-service/test/outbox-d1.ts.
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";
import { OUTBOX_DDL } from "@dub/freeq";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function makeOutboxD1(): { d1: D1Database; raw: InstanceType<typeof DatabaseSync> } {
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

export interface StoredRow {
  id: string;
  topic: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}
export function rows(raw: InstanceType<typeof DatabaseSync>): StoredRow[] {
  return raw.prepare("SELECT * FROM freeq_outbox ORDER BY created_at ASC").all() as unknown as StoredRow[];
}
