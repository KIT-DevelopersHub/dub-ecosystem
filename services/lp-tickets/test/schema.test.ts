// db/0001_init.sql must be the same physical schema as dub-core's lp_ticket_* tables after
// infra/d1/migrations/lp/*: same columns in the same ORDER (wrangler d1 export INSERTs are loaded into
// it), same types / NOT NULL / defaults / keys, same indexes.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { applyAll } from "../../../infra/d1/src/apply";
import { collectSqlDir } from "../../../infra/d1/src/collect";
import { verifySchema } from "../../../infra/d1/src/verify-schema";
import { CHECKIN_SQL, DELIVERY_SQL, INIT_SQL } from "./harness";

const TABLES = ["lp_ticket_settings", "lp_ticket_types", "lp_ticket_orders", "lp_ticket_order_items", "lp_ticket_coupons"];
const DELIVERY_TABLES = ["lp_ticket_jobs", "lp_ticket_outbox", "lp_tickets"];
const CHECKIN_TABLES = ["lp_ticket_checkins"];
type D1 = ReturnType<typeof memoryD1>["db"];

async function all(db: D1, sql: string): Promise<unknown[]> {
  return (await db.prepare(sql).all()).results;
}

async function shape(db: D1) {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    const indexes = (await all(db, `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}' AND sql IS NOT NULL ORDER BY name`)) as { name: string; sql: string }[];
    out[t] = {
      columns: await all(db, `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}') ORDER BY cid`),
      indexes: indexes.map((i) => ({ name: i.name, sql: i.sql.replace(/\s+/g, " ").replace(" IF NOT EXISTS", "") })),
      uniques: await all(db, `SELECT "unique", origin, partial FROM pragma_index_list('${t}') ORDER BY origin, "unique"`),
    };
  }
  return out;
}

describe("db/0001_init.sql", () => {
  it("is identical to dub-core's tables after every infra migration", async () => {
    const fresh = memoryD1().db;
    await fresh.exec(INIT_SQL);
    const migrated = memoryD1().db;
    await applyAll(migrated);
    expect(await shape(fresh)).toEqual(await shape(migrated));
  });

  it("the deploy schema gate reads this directory and finds nothing missing", async () => {
    const dir = fileURLToPath(new URL("../db", import.meta.url));
    const migrations = collectSqlDir(dir, "lp");
    expect(migrations.map((m) => m.id)).toEqual(["0001_init", "0002_delivery", "0003_checkin"]);
    const empty = await verifySchema(memoryD1().db, migrations, { readOnly: true });
    expect(empty.missingTables.filter((t) => t !== "dub_migrations").sort()).toEqual([...TABLES, ...DELIVERY_TABLES, ...CHECKIN_TABLES].sort());
    expect(empty.missingColumns).toEqual([]);
    // 0002 まで当てて 0003 を忘れた DB は、0003 の列が足りないと言われる（デプロイ前のゲートが止める）。
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.exec(DELIVERY_SQL);
    const before = await verifySchema(db, migrations, { readOnly: true });
    expect(before.missingTables.filter((t) => t !== "dub_migrations")).toEqual(CHECKIN_TABLES);
    expect(before.missingColumns).toEqual(
      ["lp_ticket_orders.receipt_name", "lp_ticket_types.open_registration", "lp_tickets.holder_name"],
    );
    await db.exec(CHECKIN_SQL);
    const res = await verifySchema(db, migrations, { readOnly: true });
    expect(res.missingTables.filter((t) => t !== "dub_migrations")).toEqual([]);
    expect(res.missingColumns).toEqual([]);
  });

  it("creates only the ticket tables and can be re-run", async () => {
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.exec(DELIVERY_SQL);
    await db.exec(INIT_SQL);
    await db.exec(DELIVERY_SQL);
    await db.exec(CHECKIN_SQL); // 0003 は ALTER を含むので 1 回だけ
    const rows = (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([...TABLES, ...DELIVERY_TABLES, ...CHECKIN_TABLES].sort());
  });

  it("0002 is purely additive: 0001's tables keep their exact columns and rows", async () => {
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.prepare("INSERT INTO lp_ticket_settings (site, updated_at) VALUES ('s', 't')").run();
    const before = await shape(db);
    await db.exec(DELIVERY_SQL);
    const after = (await shape(db)) as Record<string, { columns: unknown; indexes: { name: string }[] }>;
    for (const t of TABLES) expect(after[t]!.columns).toEqual((before as typeof after)[t]!.columns);
    expect(after.lp_ticket_orders!.indexes.map((i) => i.name)).toContain("idx_lp_ticket_orders_paid");
    expect(await all(db, "SELECT site FROM lp_ticket_settings")).toEqual([{ site: "s" }]);
  });

  it("0003 is purely additive: existing columns and rows stay, new columns are NULL", async () => {
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.exec(DELIVERY_SQL);
    await db
      .prepare(
        `INSERT INTO lp_ticket_types (id, site, name, price_jpy, created_at, updated_at) VALUES ('tt', 's', '一般', 3000, 't', 't')`,
      )
      .run();
    await db
      .prepare("INSERT INTO lp_tickets (id, order_id, ticket_type_id, ticket_type_name, created_at) VALUES ('o-1', 'o', 'tt', '一般', 't')")
      .run();
    const before = (await shape(db)) as Record<string, { columns: { name: string }[] }>;
    await db.exec(CHECKIN_SQL);
    const after = (await shape(db)) as typeof before;
    for (const t of TABLES) {
      expect(after[t]!.columns.slice(0, before[t]!.columns.length)).toEqual(before[t]!.columns);
    }
    expect(after.lp_ticket_types!.columns.at(-1)).toMatchObject({ name: "open_registration", notnull: 0, dflt_value: null });
    expect(after.lp_ticket_orders!.columns.at(-1)).toMatchObject({ name: "receipt_name", notnull: 0, dflt_value: null });
    expect(await all(db, "SELECT open_registration FROM lp_ticket_types")).toEqual([{ open_registration: null }]);
    expect(await all(db, "SELECT id, holder_name FROM lp_tickets")).toEqual([{ id: "o-1", holder_name: null }]);
  });

  it("lp_ticket_checkins: one check-in per ticket per event day (a pass checks in on each day once)", async () => {
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.exec(DELIVERY_SQL);
    await db.exec(CHECKIN_SQL);
    const checkin = async (ticket: string, day: string, by: string) =>
      (
        await db
          .prepare(
            "INSERT INTO lp_ticket_checkins (ticket_id, event_day, checked_in_at, checked_in_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
          )
          .bind(ticket, day, `${day}T09:00:00.000Z`, by)
          .run()
      ).meta.changes;
    expect(await checkin("o-1", "2026-12-12", "u_a")).toBe(1);
    expect(await checkin("o-1", "2026-12-12", "u_b")).toBe(0); // 2 回目 = 受付済み
    expect(await checkin("o-1", "2026-12-13", "u_a")).toBe(1); // 通し券の 2 日目
    expect(await checkin("o-2", "2026-12-12", "u_a")).toBe(1);
    expect(await all(db, "SELECT ticket_id, event_day, checked_in_by FROM lp_ticket_checkins ORDER BY event_day, ticket_id")).toEqual([
      { ticket_id: "o-1", event_day: "2026-12-12", checked_in_by: "u_a" },
      { ticket_id: "o-2", event_day: "2026-12-12", checked_in_by: "u_a" },
      { ticket_id: "o-1", event_day: "2026-12-13", checked_in_by: "u_a" },
    ]);
  });
});
