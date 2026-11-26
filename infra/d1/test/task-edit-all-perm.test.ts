// identity 0038 (#881): task:edit_all goes to the roles that run tasks today (admin, holders of
// task:delete or event:write) and NOT to a plain task:write member, idempotently.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { migratedD1 } from "./d1";

const SQL = readFileSync(new URL("../migrations/identity/0038_task_edit_all_perm.sql", import.meta.url), "utf8");
const T = "2026-11-26T00:00:00.000Z";

describe("identity 0038_task_edit_all_perm", () => {
  it("grants admin / maintainer / organizer and custom operator roles, not member; re-run is a no-op", async () => {
    const { raw } = await migratedD1();
    const role = raw.prepare(`INSERT INTO identity_roles (id, org_id, name, is_system, created_at, updated_at) VALUES (?, 'org_devhub', ?, 0, ?, ?)`);
    const grant = raw.prepare(`INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES (?, ?)`);
    role.run("role_lead", "リーダー", T, T);
    grant.run("role_lead", "task:write");
    grant.run("role_lead", "event:write");
    role.run("role_writer", "書く人", T, T);
    grant.run("role_writer", "task:write");
    raw.exec(SQL);
    raw.exec(SQL);
    const holders = raw
      .prepare(`SELECT role_id FROM identity_role_permissions WHERE permission_key = 'task:edit_all' ORDER BY role_id`)
      .all()
      .map((r) => (r as { role_id: string }).role_id);
    expect(holders).toEqual(["role_lead", "role_sys_admin", "role_sys_maintainer", "role_sys_organizer"]);
  });
});
