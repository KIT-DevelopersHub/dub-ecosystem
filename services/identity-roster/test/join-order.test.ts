// orgWideRolePeers / orgWideMailVisibleUsers must drive the join from the caller's own
// assignments (`mine`). Left to the planner, SQLite starts from every org-wide assignment
// (prod: 1,217 / 314 rows read per call instead of 6). CROSS JOIN pins the order.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import { D1IdentityRepo } from "../src/repo/d1-repo";
import { makeOutboxD1 } from "./outbox-d1";

const migration = (f: string) => readFileSync(new URL(`../../../infra/d1/migrations/identity/${f}`, import.meta.url), "utf8");

function captureRepo() {
  const { d1, raw } = makeOutboxD1();
  raw.exec(migration("0001_init.sql"));
  raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
  raw.exec(migration("0018_role_mail_visibility.sql"));
  const seen: string[] = [];
  const prepare = d1.prepare.bind(d1);
  (d1 as { prepare: typeof d1.prepare }).prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  const firstTable = (sql: string) => {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
    return plan.map((p) => p.detail).find((d) => /^(SCAN|SEARCH) /.test(d));
  };
  return { repo: new D1IdentityRepo(createDbClient(d1, { namespace: "identity" })), seen, firstTable };
}

describe("D1IdentityRepo org-wide peer queries start from the caller's assignments", () => {
  it("orgWideRolePeers", async () => {
    const { repo, seen, firstTable } = captureRepo();
    await repo.orgWideRolePeers("org_x", "u_a", "mail:read_role_shared");
    expect(firstTable(seen.at(-1)!)).toMatch(/^SEARCH mine USING INDEX idx_identity_role_assignments_user/);
  });

  it("orgWideMailVisibleUsers", async () => {
    const { repo, seen, firstTable } = captureRepo();
    await repo.orgWideMailVisibleUsers("org_x", "u_a");
    expect(firstTable(seen.at(-1)!)).toMatch(/^SEARCH mine USING INDEX idx_identity_role_assignments_user/);
  });
});
