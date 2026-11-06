// db/0001_init.sql must be the same physical schema as dub-core's lp_ticket_* tables after
// infra/d1/migrations/lp/*: same columns in the same ORDER (wrangler d1 export INSERTs are loaded into
// it), same types / NOT NULL / defaults / keys, same indexes.
import { describe, it, expect } from "vitest";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { applyAll } from "../../../infra/d1/src/apply";
import { INIT_SQL } from "./harness";

const TABLES = ["lp_ticket_settings", "lp_ticket_types", "lp_ticket_orders", "lp_ticket_order_items", "lp_ticket_coupons"];
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

  it("creates only the ticket tables and can be re-run", async () => {
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.exec(INIT_SQL);
    const rows = (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([...TABLES].sort());
  });
});
