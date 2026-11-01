// In-memory SQLite D1 for the Slack import step engine: the REAL physical migrations of
// every table the engine writes (chat_*, identity_users, file_meta_*), FKs on, and a
// TRANSACTIONAL batch() like D1's — so "a failed step leaves nothing behind" is tested.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/d1/migrations");
const NAMESPACES = ["identity", "chat", "file_meta"];

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export type RawDb = InstanceType<typeof DatabaseSync>;

export function makeImportD1(): { d1: D1Database; raw: RawDb } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const ns of NAMESPACES) {
    const dir = join(MIGRATIONS, ns);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(join(dir, f), "utf8"));
  }

  const adapter = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const api = {
        bind(...b: unknown[]) {
          args = b.map(norm);
          return api;
        },
        async first<T>(): Promise<T | null> {
          return (raw.prepare(sql).get(...(args as never[])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: raw.prepare(sql).all(...(args as never[])) as T[], success: true, meta: {} };
        },
        runSync() {
          const r = raw.prepare(sql).run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
        },
        async run() {
          return api.runSync();
        },
      };
      return api;
    },
    async batch(stmts: Array<{ runSync: () => unknown }>) {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  return { d1: adapter, raw };
}

export function count(raw: RawDb, sql: string, ...args: unknown[]): number {
  const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${sql}`).get(...(args as never[])) as { c: number };
  return Number(row.c);
}
