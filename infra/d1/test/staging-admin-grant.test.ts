import { describe, it, expect } from "vitest";
import { identity } from "@dub/types";
import { STAGING_DB, stagingAdminGrantSql } from "../src/staging-admin-grant";
import { emptyD1, migratedD1 } from "./d1";

const adminKeys = (raw: Awaited<ReturnType<typeof migratedD1>>["raw"]): Set<string> =>
  new Set(
    (raw
      .prepare("SELECT permission_key FROM identity_role_permissions WHERE role_id = 'role_sys_admin'")
      .all() as Array<{ permission_key: string }>).map((r) => r.permission_key),
  );

describe("stagingAdminGrantSql", () => {
  it("restores keys a staging D1 never received (data-only migrations skipped)", async () => {
    const { raw } = await migratedD1();
    raw.exec(
      "DELETE FROM identity_role_permissions WHERE role_id = 'role_sys_admin' AND permission_key IN ('notif:receive_admin','chat:slack_import','drive:settings_edit')",
    );
    raw.exec(stagingAdminGrantSql());
    const have = adminKeys(raw);
    const missing = identity.PERMISSION_CATALOG.map((e) => e.key).filter((k) => !have.has(k));
    expect(missing).toEqual([]);
  });

  it("is idempotent and touches only role_sys_admin", async () => {
    const { raw } = await migratedD1();
    const others = () =>
      raw.prepare("SELECT role_id, permission_key FROM identity_role_permissions WHERE role_id <> 'role_sys_admin' ORDER BY 1, 2").all();
    const before = others();
    raw.exec(stagingAdminGrantSql());
    raw.exec(stagingAdminGrantSql());
    expect(others()).toEqual(before);
    expect(adminKeys(raw).size).toBeGreaterThanOrEqual(identity.PERMISSION_CATALOG.length);
  });

  it("is a no-op when role_sys_admin does not exist", async () => {
    const { raw } = emptyD1();
    raw.exec("CREATE TABLE identity_roles (id TEXT PRIMARY KEY)");
    raw.exec("CREATE TABLE identity_role_permissions (role_id TEXT NOT NULL, permission_key TEXT NOT NULL, PRIMARY KEY (role_id, permission_key))");
    raw.exec(stagingAdminGrantSql(["a:b"]));
    const row = raw.prepare("SELECT COUNT(*) AS c FROM identity_role_permissions").get() as { c: number };
    expect(Number(row.c)).toBe(0);
  });

  it("rejects keys that are not plain identifiers", () => {
    expect(() => stagingAdminGrantSql(["x'); DROP TABLE t; --"])).toThrow();
    expect(() => stagingAdminGrantSql([])).toThrow();
  });

  it("targets staging D1s only", () => {
    expect(STAGING_DB.test("dub-core-staging")).toBe(true);
    expect(STAGING_DB.test("dub-core-staging2")).toBe(true);
    expect(STAGING_DB.test("dub-core")).toBe(false);
  });
});
