// A real, seeded in-memory D1 backed by node:sqlite (DatabaseSync). Mirrors the
// per-service test/d1.ts adapters already used across this repo, but loads EVERY
// service namespace's schema into one database so a single seeded "local D1" can
// back a cross-service smoke run. No miniflare / wrangler — plain node + vitest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";

import { EVENT_SCHEMA_MIGRATION } from "../../../services/event-service/src/index";
import { TASK_MIGRATIONS } from "../../../services/task-service/src/migrations";

// Load node:sqlite through createRequire so Vitest's transform pipeline never tries
// to bundle it (it would strip "node:" and 404). Same trick as the service adapters.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const sqlFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The DDL for every namespace this smoke touches (event, task, notif, mail). */
export function allSchemas(): string[] {
  return [
    EVENT_SCHEMA_MIGRATION.up,
    ...TASK_MIGRATIONS.map((m) => m.up),
    sqlFile("../../../services/notification/db/0001_notif.sql"),
    sqlFile("../../../services/notification/db/0002_feedback.sql"),
    sqlFile("../../../services/notification/db/0003_freeq_outbox.sql"),
    sqlFile("../../../services/notification/db/0004_audience.sql"),
    sqlFile("../../../services/mail-gateway/db/0001_mail.sql"),
    sqlFile("../../../services/mail-gateway/db/0002_inbound_body_read.sql"),
    sqlFile("../../../services/mail-gateway/db/0003_freeq_outbox.sql"),
    sqlFile("../../../services/mail-gateway/db/0004_send_body.sql"),
    sqlFile("../../../services/mail-gateway/db/0006_owner_scope.sql"),
  ];
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

/** Build a fresh seeded D1 (all namespaces) plus the raw handle for assertions. */
export function makeSeededD1(): { d1: D1Database; raw: InstanceType<typeof DatabaseSync> } {
  const raw = new DatabaseSync(":memory:");
  for (const schema of allSchemas()) raw.exec(schema);

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
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 },
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
