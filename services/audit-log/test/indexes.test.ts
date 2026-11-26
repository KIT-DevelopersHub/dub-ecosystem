// #841: audit_logs keeps only the indexes a real query needs (each extra index is one more
// D1 row written per INSERT). Pins the remaining set and that the queries that justified
// keeping them still use them.
import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1";

function plan(raw: ReturnType<typeof makeD1>["raw"], sql: string, ...args: string[]): string {
  const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
  return rows.map((r) => r.detail).join(" | ");
}

describe("audit_logs indexes (#841)", () => {
  it("only the PK autoindex + actor + action indexes remain", () => {
    const { raw } = makeD1();
    const names = (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_logs' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(["idx_audit_logs_action", "idx_audit_logs_actor", "sqlite_autoindex_audit_logs_1"]);
  });

  it("FE7 actor filter uses idx_audit_logs_actor", () => {
    const { raw } = makeD1();
    expect(plan(raw, `SELECT * FROM audit_logs WHERE actor_id = ? ORDER BY id DESC LIMIT 51`, "u1")).toContain(
      "idx_audit_logs_actor",
    );
  });

  it("FE7 exact-action filter uses idx_audit_logs_action", () => {
    const { raw } = makeD1();
    expect(plan(raw, `SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 51`, "identity.user.invite")).toContain(
      "idx_audit_logs_action",
    );
  });

  it("default identity.* prefix query walks the PK (ULID) order without a sort", () => {
    const { raw } = makeD1();
    const p = plan(raw, `SELECT * FROM audit_logs WHERE action LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 51`, "identity.%");
    expect(p).toContain("sqlite_autoindex_audit_logs_1");
    expect(p).not.toContain("TEMP B-TREE");
  });
});
