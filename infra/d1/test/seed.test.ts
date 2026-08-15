import { describe, it, expect } from "vitest";
import { identity } from "@dub/types";
import { seedScenario } from "../seed/scenarios";
import { applyAndSeed } from "../seed/seed-demo";
import { SEED } from "../seed/fixtures";
import { PROD_DB_NAME } from "../src/errors";
import { memoryD1 } from "../src/node-d1";
import { migratedD1, count, fkViolations, exists } from "./d1";

describe("seedScenario", () => {
  it("#5 conference-demo is idempotent and records seed_runs", async () => {
    const { db, raw } = await migratedD1();
    const h1 = await seedScenario(db, "conference-demo");
    expect(h1.runId).toBe("fixed");
    expect(h1.inserted).toBeGreaterThan(0);

    const snapshot = () => ["identity_users", "task_tasks", "event_events", "notif_notifications", "file_meta_files", "audit_logs"].map((t) => count(raw, t));
    const after1 = snapshot();
    await seedScenario(db, "conference-demo");
    const after2 = snapshot();
    expect(after2).toEqual(after1);

    expect(count(raw, "task_tasks")).toBe(10);
    expect(exists(raw, "seed_runs", "run_id", "fixed")).toBe(true);
  });

  it("#6 seed leaves referential integrity intact", async () => {
    const { db, raw } = await migratedD1();
    await seedScenario(db, "conference-demo");
    expect(fkViolations(raw)).toEqual([]);
    // cross-namespace id join: every demo user's org exists in identity_orgs
    const orphanUsers = raw
      .prepare("SELECT COUNT(*) AS c FROM identity_users u LEFT JOIN identity_orgs o ON u.org_id = o.id WHERE o.id IS NULL")
      .get() as { c: number };
    expect(Number(orphanUsers.c)).toBe(0);
  });

  it("#7 refuses to seed the prod database", async () => {
    const { db } = await migratedD1();
    await expect(seedScenario(db, "conference-demo", { databaseName: PROD_DB_NAME })).rejects.toMatchObject({ code: "SEED_ENV_FORBIDDEN" });
  });

  it("#8 all frozen SEED ids (3 primary users + roles) exist after conference-demo", async () => {
    const { db, raw } = await migratedD1();
    await seedScenario(db, "conference-demo");
    for (const key of ["admin", "organizer", "member"] as const) {
      expect(exists(raw, "identity_users", "id", SEED.users[key].id), `user ${key}`).toBe(true);
    }
    expect(exists(raw, "identity_orgs", "id", SEED.orgs.primary.id)).toBe(true);
    expect(exists(raw, "event_events", "id", SEED.event.id)).toBe(true);
  });

  it("#10 rbac-matrix adds the outsider org + outsider user (4 users, 2 orgs)", async () => {
    const { db, raw } = await migratedD1();
    await seedScenario(db, "rbac-matrix");
    expect(exists(raw, "identity_users", "id", SEED.users.outsider.id)).toBe(true);
    expect(exists(raw, "identity_orgs", "id", SEED.orgs.outsider.id)).toBe(true);
    expect(count(raw, "identity_users")).toBe(4);
    // org_devhub (migration) + outsider (seed)
    expect(count(raw, "identity_orgs")).toBe(2);
    expect(fkViolations(raw)).toEqual([]);
  });

  it("#11 isolate runs are independent and cleanup removes only their own rows", async () => {
    const { db, raw } = await migratedD1();
    const a = await seedScenario(db, "rbac-matrix", { isolate: true });
    const b = await seedScenario(db, "rbac-matrix", { isolate: true });
    expect(a.runId).not.toBe(b.runId);
    expect(a.runId).not.toBe("fixed");

    const adminA = SEED.users.admin.id + "_" + a.runId;
    const adminB = SEED.users.admin.id + "_" + b.runId;
    expect(exists(raw, "identity_users", "id", adminA)).toBe(true);
    expect(exists(raw, "identity_users", "id", adminB)).toBe(true);

    await a.cleanup();
    expect(exists(raw, "identity_users", "id", adminA)).toBe(false);
    expect(exists(raw, "identity_users", "id", adminB)).toBe(true);
    expect(exists(raw, "seed_runs", "run_id", a.runId)).toBe(false);
    expect(exists(raw, "seed_runs", "run_id", b.runId)).toBe(true);
  });

  it("conference-demo seeds a chat channel with a threaded conversation", async () => {
    const { db, raw } = await migratedD1();
    await seedScenario(db, "conference-demo");
    expect(exists(raw, "chat_channels", "id", SEED.channel.general)).toBe(true);
    expect(exists(raw, "chat_messages", "id", SEED.messages.welcome)).toBe(true);
    // the reply threads onto the welcome message.
    const reply = raw.prepare("SELECT thread_root_id FROM chat_messages WHERE id = ?").get(SEED.messages.reply) as { thread_root_id: string };
    expect(reply.thread_root_id).toBe(SEED.messages.welcome);
    // 3 primary users all become channel members with read states, admin is channel admin.
    expect(count(raw, "chat_channel_members")).toBe(3);
    expect(count(raw, "chat_read_states")).toBe(3);
    const adminRole = raw.prepare("SELECT role FROM chat_channel_members WHERE channel_id = ? AND user_id = ?").get(SEED.channel.general, SEED.users.admin.id) as { role: string };
    expect(adminRole.role).toBe("admin");
    expect(fkViolations(raw)).toEqual([]);
  });

  it("minimal skips chat (channel-free minimal surface)", async () => {
    const { db, raw } = await migratedD1();
    await seedScenario(db, "minimal");
    expect(count(raw, "chat_channels")).toBe(0);
  });

  it("#12 audit_logs re-seed is idempotent despite the append-only trigger", async () => {
    const { db, raw } = await migratedD1();
    await seedScenario(db, "conference-demo");
    const first = count(raw, "audit_logs");
    expect(first).toBeGreaterThan(0);
    await seedScenario(db, "conference-demo"); // INSERT OR IGNORE — no trigger conflict
    expect(count(raw, "audit_logs")).toBe(first);
  });

  it("minimal is fixed-only even when isolate is requested", async () => {
    const { db } = await migratedD1();
    const h = await seedScenario(db, "minimal", { isolate: true });
    expect(h.runId).toBe("fixed");
  });

  it("applyAndSeed provisions a raw DB in one call (migrate + seed)", async () => {
    const { db, raw } = memoryD1();
    const h = await applyAndSeed(db, "conference-demo");
    expect(h.scenario).toBe("conference-demo");
    expect(count(raw, "task_tasks")).toBe(10);
    expect(fkViolations(raw)).toEqual([]);
  });

  // Regression (prod incident 2026-08-15): every system role must grant the FE5
  // self-service notification scopes. The notifications inbox (/notifications) and
  // preferences (/settings/notifications) pages gate on these in the SPA, so a role
  // missing them makes 通知一覧 a 403 for that tier — invisible to the demo, whose
  // DEMO_PERMISSIONS hard-code both perms. Migration 0004_notif_self_perms closes it.
  it("every system role grants notif:inbox:self + notif:prefs:self (migration only)", async () => {
    const { raw } = await migratedD1();
    const roles = ["role_sys_admin", "role_sys_maintainer", "role_sys_organizer", "role_sys_member"];
    const perms = ["notif:inbox:self", "notif:prefs:self"];
    for (const roleId of roles) {
      for (const permKey of perms) {
        const row = raw
          .prepare("SELECT 1 AS ok FROM identity_role_permissions WHERE role_id = ? AND permission_key = ?")
          .get(roleId, permKey) as { ok: number } | undefined;
        expect(row?.ok, `${roleId} must grant ${permKey}`).toBe(1);
      }
    }
  });

  // Super-admin invariant (prod incident 2026-08-15 — "adminなのに操作ボタンが押せない" が頻発):
  // the `admin` system role must hold EVERY key in the frozen RBAC catalog. The 0002 seed
  // drifted below the catalog and single holes were patched reactively (drive:* / mail:read_all /
  // notif self / github:* / webhook:read). This guard fails the build the instant a new catalog
  // key is added without granting it to admin — so "admin is missing a permission" can never
  // silently ship again. The fill migrations are the 正本; admin = the full catalog, always.
  it("admin holds the ENTIRE frozen permission catalog (no missing keys, migration only)", async () => {
    const { raw } = await migratedD1();
    const granted = new Set(
      (raw
        .prepare("SELECT permission_key FROM identity_role_permissions WHERE role_id = 'role_sys_admin'")
        .all() as Array<{ permission_key: string }>).map((r) => r.permission_key),
    );
    const missing = identity.PERMISSION_CATALOG.map((e) => e.key).filter((k) => !granted.has(k));
    expect(missing, `admin missing catalog perms: ${missing.join(", ")}`).toEqual([]);
  });
});
