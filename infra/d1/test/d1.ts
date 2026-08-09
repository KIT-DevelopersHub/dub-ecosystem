// Test harness: an in-memory node:sqlite D1 with the aggregated schema applied.
import { memoryD1 } from "../src/node-d1";
import { applyAll } from "../src/apply";
import type { D1Database } from "@cloudflare/workers-types";

type Raw = ReturnType<typeof memoryD1>["raw"];

export async function migratedD1(): Promise<{ db: D1Database; raw: Raw }> {
  const { db, raw } = memoryD1();
  await applyAll(db);
  return { db, raw };
}

export function emptyD1(): { db: D1Database; raw: Raw } {
  return memoryD1();
}

export function count(raw: Raw, table: string): number {
  const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return Number(row.c);
}

export function fkViolations(raw: Raw): unknown[] {
  return raw.prepare("PRAGMA foreign_key_check").all();
}

export function exists(raw: Raw, table: string, idCol: string, id: string): boolean {
  const row = raw.prepare(`SELECT 1 AS x FROM ${table} WHERE ${idCol} = ?`).get(id);
  return row != null;
}
