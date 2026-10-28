import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DestructiveOpRefused, guardedBulkDelete } from "../src/destructive";
import { makeHarness } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const HELPER = "destructive.ts";
// Any physical delete of a mail_ table: literal `DELETE FROM mail_x` or an interpolated
// table name (`DELETE FROM ${t}`) — both must live in the guard helper only.
const RAW_DELETE = /DELETE\s+FROM\s+(?:mail_|\$\{)/i;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function addInbound(raw: ReturnType<typeof makeHarness>["raw"], id: string, receivedAt: string) {
  raw.prepare(
    `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
     VALUES (?, ?, 't', '{}', '[]', 's', 'snip', ?, ?)`,
  ).run(id, `m_${id}`, receivedAt, receivedAt);
}

describe("destructive-operation guard", () => {
  it("no raw `DELETE FROM mail_` in src/ outside the guard helper", () => {
    const offenders = tsFiles(SRC)
      .filter((f) => relative(SRC, f) !== HELPER)
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${relative(SRC, f)}:${i + 1}` }))
          .filter(({ line }) => RAW_DELETE.test(line))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });

  it("the scan pattern actually catches the shapes it guards against", () => {
    expect(RAW_DELETE.test("await db.run(`DELETE FROM mail_inbound WHERE received_at < ?`)")).toBe(true);
    expect(RAW_DELETE.test("`delete from mail_send_log`")).toBe(true);
    expect(RAW_DELETE.test("`DELETE FROM ${table} WHERE 1`")).toBe(true);
    expect(RAW_DELETE.test("DELETE /mail/scheduled/:id")).toBe(false);
  });

  it("refuses unless MAIL_DESTRUCTIVE_OPS is exactly \"on\" (nothing changes)", async () => {
    const h = makeHarness();
    addInbound(h.raw, "a", "2026-01-01T00:00:00.000Z");
    for (const flag of [undefined, "", "true", "ON", "off"]) {
      await expect(guardedBulkDelete(h.db, flag, { table: "mail_inbound", where: "1=1", reason: "t", now: NOW })).rejects.toBeInstanceOf(
        DestructiveOpRefused,
      );
    }
    const row = h.raw.prepare(`SELECT deleted_at FROM mail_inbound WHERE id = 'a'`).get() as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it("refuses a table outside the guarded set", async () => {
    const h = makeHarness();
    await expect(
      guardedBulkDelete(h.db, "on", { table: "mail_attachments" as never, where: "1=1", reason: "t", now: NOW }),
    ).rejects.toBeInstanceOf(DestructiveOpRefused);
  });

  it("soft-deletes first; purges only after the grace period", async () => {
    const h = makeHarness();
    addInbound(h.raw, "old", "2026-01-01T00:00:00.000Z");
    addInbound(h.raw, "new", "2026-10-01T00:00:00.000Z");
    const spec = { table: "mail_inbound" as const, where: "received_at < ?", binds: ["2026-06-01"], reason: "test" };

    const first = await guardedBulkDelete(h.db, "on", { ...spec, now: NOW });
    expect(first).toEqual({ matched: 1, softDeleted: 1, purged: 0 });
    const rows = () => h.raw.prepare(`SELECT id, deleted_at FROM mail_inbound ORDER BY id`).all() as { id: string; deleted_at: string | null }[];
    expect(rows()).toEqual([
      { id: "new", deleted_at: null },
      { id: "old", deleted_at: new Date(NOW).toISOString() },
    ]);

    const tooSoon = await guardedBulkDelete(h.db, "on", { ...spec, now: NOW + 29 * DAY });
    expect(tooSoon.purged).toBe(0);

    const afterGrace = await guardedBulkDelete(h.db, "on", { ...spec, now: NOW + 30 * DAY });
    expect(afterGrace).toEqual({ matched: 1, softDeleted: 0, purged: 1 });
    expect(rows().map((r) => r.id)).toEqual(["new"]);
  });
});
