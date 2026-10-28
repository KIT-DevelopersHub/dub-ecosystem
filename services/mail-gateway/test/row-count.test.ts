import { describe, it, expect } from "vitest";
import type { ScheduledController } from "@cloudflare/workers-types";
import handler from "../src/index";
import { runRowCountSnapshot } from "../src/row-count";
import { ctx, makeEnv, makeHarness } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 27, 0, 5);

function addInbound(raw: ReturnType<typeof makeHarness>["raw"], id: string) {
  raw.prepare(
    `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
     VALUES (?, ?, 't', '{}', '[]', 's', 'snip', '2026-01-01', '2026-01-01')`,
  ).run(id, `m_${id}`);
}
const snaps = (raw: ReturnType<typeof makeHarness>["raw"]) =>
  raw.prepare(`SELECT snapshot_date, table_name, row_count FROM mail_row_count_snapshots ORDER BY snapshot_date, table_name`).all();

describe("daily row-count snapshot", () => {
  it("records both tables once per UTC day (later ticks are no-ops)", async () => {
    const h = makeHarness();
    addInbound(h.raw, "a");
    const deps = { db: h.db, audit: h.audit, orgId: "org_devhub", ctx: ctx() };
    const r1 = await runRowCountSnapshot(deps, T0);
    expect(r1.recorded).toEqual(["mail_inbound", "mail_send_log"]);
    addInbound(h.raw, "b");
    const r2 = await runRowCountSnapshot(deps, T0 + 5 * 60_000);
    expect(r2.recorded).toEqual([]);
    expect(snaps(h.raw)).toEqual([
      { snapshot_date: "2026-10-27", table_name: "mail_inbound", row_count: 1 },
      { snapshot_date: "2026-10-27", table_name: "mail_send_log", row_count: 0 },
    ]);
  });

  it("no alert when counts grow or stay", async () => {
    const h = makeHarness();
    const deps = { db: h.db, audit: h.audit, orgId: "org_devhub", ctx: ctx() };
    addInbound(h.raw, "a");
    await runRowCountSnapshot(deps, T0);
    addInbound(h.raw, "b");
    const r = await runRowCountSnapshot(deps, T0 + DAY);
    expect(r.decreases).toEqual([]);
    expect(h.auditQ.sends).toHaveLength(0);
  });

  it("alerts through the audit channel when today's count < yesterday's", async () => {
    const h = makeHarness();
    const deps = { db: h.db, audit: h.audit, orgId: "org_devhub", ctx: ctx() };
    addInbound(h.raw, "a");
    addInbound(h.raw, "b");
    await runRowCountSnapshot(deps, T0);
    h.raw.prepare(`DELETE FROM mail_inbound WHERE id = 'a'`).run(); // simulated loss
    const r = await runRowCountSnapshot(deps, T0 + DAY);
    expect(r.decreases).toEqual([{ table: "mail_inbound", previousDate: "2026-10-27", previousCount: 2, count: 1 }]);
    expect(h.auditQ.sends).toHaveLength(1);
    const p = h.auditQ.sends[0]!.payload;
    expect(p.action).toBe("mail.data.row_count_decreased");
    expect(p.result).toBe("failure");
    expect(p.resourceId).toBe("mail_inbound");
    expect(p.details).toMatchObject({ lost: 1, previousCount: 2, count: 1 });
  });

  it("never throws (a broken DB is logged, not raised)", async () => {
    const h = makeHarness();
    const broken = { ...h.db, first: async () => { throw new Error("d1 down"); } } as typeof h.db;
    await expect(runRowCountSnapshot({ db: broken, audit: h.audit, orgId: "o", ctx: ctx() }, T0)).resolves.toMatchObject({ recorded: [] });
  });

  it("scheduled() takes the snapshot on its tick", async () => {
    const { env, raw } = makeEnv();
    const controller = { scheduledTime: T0, cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController;
    await handler.scheduled(controller, env);
    expect(snaps(raw)).toHaveLength(2);
  });
});
