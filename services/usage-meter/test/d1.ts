// In-memory node:sqlite adapter exposing the subset of D1Database that @dub/db's DbClient
// uses (prepare().bind().first/all/run + batch), seeded with the REAL usage_snapshot and
// mail_send_log DDL from infra/d1/migrations — so the UPSERT and COUNT SQL run authentically.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const USAGE_DDL = readFileSync(
  fileURLToPath(new URL("../../../infra/d1/migrations/usage/0001_init.sql", import.meta.url)),
  "utf8",
);
const MAIL_DDL = readFileSync(
  fileURLToPath(new URL("../../../infra/d1/migrations/mail/0001_init.sql", import.meta.url)),
  "utf8",
);

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function makeD1(): { d1: D1Database; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(USAGE_DDL);
  raw.exec(MAIL_DDL);

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

/** Seed a mail_send_log row (defaults status=sent). */
export function seedSend(
  raw: InstanceType<typeof DatabaseSync>,
  id: string,
  createdAt: string,
  status = "sent",
): void {
  raw
    .prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, status, created_at, updated_at)
       VALUES (?, ?, 'h', 'svc', '[]', 's', ?, ?, ?)`,
    )
    .run(id, `idem-${id}`, status, createdAt, createdAt);
}

export interface SnapshotRawRow {
  metric_key: string;
  used: number | null;
  pct: number | null;
  status: string;
  capture_day: string;
}
export function readSnapshot(raw: InstanceType<typeof DatabaseSync>, metricKey: string): SnapshotRawRow | undefined {
  return raw
    .prepare(`SELECT metric_key, used, pct, status, capture_day FROM usage_snapshot WHERE metric_key = ?`)
    .get(metricKey) as SnapshotRawRow | undefined;
}
export function countSnapshot(raw: InstanceType<typeof DatabaseSync>): number {
  return Number((raw.prepare(`SELECT COUNT(*) AS c FROM usage_snapshot`).get() as { c: number }).c);
}
