// Real in-memory SQLite adapter exposing the subset of D1Database the @dub/freeq drain
// uses, seeded with the outbox DDL — so the outbox SQL (INSERT OR IGNORE, the drain
// claim query, the status UPDATEs) is exercised authentically, not mocked. Mirrors
// packages/freeq/test/d1.ts.
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

// A stub Fetcher (service binding) that records every request and returns a scripted
// Response. `status` may be a fixed number or a function of the call index (for retry tests).
export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
export function fakeSvc(status: number | ((n: number) => number) = 200): {
  svc: import("@cloudflare/workers-types").Fetcher;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const svc = {
    async fetch(input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      const n = calls.length + 1;
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      const code = typeof status === "function" ? status(n) : status;
      return new Response(null, { status: code });
    },
  } as unknown as import("@cloudflare/workers-types").Fetcher;
  return { svc, calls };
}

export interface RawRow {
  id: string;
  topic: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}
export function readRow(raw: InstanceType<typeof DatabaseSync>, id: string): RawRow | undefined {
  return raw.prepare(`SELECT id, topic, status, attempts, next_attempt_at, last_error FROM freeq_outbox WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
}
export function seed(raw: InstanceType<typeof DatabaseSync>, id: string, topic: string, payload: unknown, at = "2000-01-01T00:00:00.000Z"): void {
  raw
    .prepare(
      `INSERT INTO freeq_outbox (id, topic, payload, status, attempts, next_attempt_at, created_at, last_error)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL)`,
    )
    .run(id, topic, JSON.stringify(payload ?? null), at, at);
}
