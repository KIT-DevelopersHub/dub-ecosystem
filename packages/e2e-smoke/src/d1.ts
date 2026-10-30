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
    // #260: the gantt WBS/team columns (team_id/parent_id/wbs) live in a physical
    // migration that is intentionally NOT mirrored into TASK_MIGRATIONS (pinned to
    // 0001_init by the drift test). The real task repo now INSERT/SELECTs them, so
    // the seeded smoke D1 must apply that migration too — matching production, where
    // every physical task migration runs.
    sqlFile("../../../infra/d1/migrations/task/0004_gantt_hierarchy.sql"),
    // PR-C: planned start (task_tasks.start_at). Same rationale as 0004 — the repo now
    // SELECT/INSERTs start_at, so the seeded smoke D1 must apply this physical migration.
    sqlFile("../../../infra/d1/migrations/task/0005_task_start_at.sql"),
    sqlFile("../../../services/notification/db/0001_notif.sql"),
    sqlFile("../../../services/notification/db/0002_feedback.sql"),
    sqlFile("../../../services/notification/db/0003_freeq_outbox.sql"),
    sqlFile("../../../services/notification/db/0004_audience.sql"),
    sqlFile("../../../services/mail-gateway/db/0001_mail.sql"),
    sqlFile("../../../services/mail-gateway/db/0002_inbound_body_read.sql"),
    sqlFile("../../../services/mail-gateway/db/0003_freeq_outbox.sql"),
    sqlFile("../../../services/mail-gateway/db/0004_send_body.sql"),
    // Every forward-only mail migration, in id order (same list as
    // services/mail-gateway/test/d1.ts): the real send core now writes columns added after
    // 0006 (e.g. 0018 bcc_json), so a partial schema fails the smoke's outbox step.
    sqlFile("../../../services/mail-gateway/db/0005_attachments.sql"),
    sqlFile("../../../services/mail-gateway/db/0006_owner_scope.sql"),
    sqlFile("../../../services/mail-gateway/db/0007_attachment_status.sql"),
    sqlFile("../../../services/mail-gateway/db/0008_user_flags.sql"),
    sqlFile("../../../services/mail-gateway/db/0009_user_flags_purged.sql"),
    sqlFile("../../../services/mail-gateway/db/0010_scheduled_send.sql"),
    sqlFile("../../../services/mail-gateway/db/0011_user_flags_no_reply.sql"),
    sqlFile("../../../services/mail-gateway/db/0012_inbound_cc.sql"),
    sqlFile("../../../services/mail-gateway/db/0013_inbound_header_meta.sql"),
    sqlFile("../../../services/mail-gateway/db/0014_inbound_raw_eml.sql"),
    sqlFile("../../../services/mail-gateway/db/0015_row_count_snapshot.sql"),
    sqlFile("../../../services/mail-gateway/db/0016_soft_delete.sql"),
    sqlFile("../../../services/mail-gateway/db/0017_mail_canary_probe.sql"),
    sqlFile("../../../services/mail-gateway/db/0018_inbound_delivery.sql"),
    sqlFile("../../../services/mail-gateway/db/0019_mail_provider_event.sql"),
    sqlFile("../../../services/mail-gateway/db/0020_scheduled_attachments_bcc.sql"),
    sqlFile("../../../services/mail-gateway/db/0021_sender_blocks.sql"),
    sqlFile("../../../services/mail-gateway/db/0022_sender_blocks_kind_index.sql"),
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
