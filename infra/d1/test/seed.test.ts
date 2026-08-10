import { describe, it, expect } from "vitest";
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
});
