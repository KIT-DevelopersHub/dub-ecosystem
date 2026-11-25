// POST /internal/users/:id/activate — member-service が「在籍で紐付いた」と確定した人の
// 招待中アカウントを有効化する。invited だけを active にし、他の状態には触れない。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { readFileSync } from "node:fs";
import { createDbClient } from "@dub/db";
import { D1IdentityRepo } from "../src/repo/d1-repo";
import { makeOutboxD1 } from "./outbox-d1";
import { makeHarness, asUser, internal, jsonBody, ORG_ID, type Harness } from "./harness";

async function invite(h: Harness, email: string): Promise<string> {
  const res = await h.app.request("/identity/users/invite", jsonBody(asUser(h.adminId), "POST", { email, displayName: "Inv" }));
  return ((await res.json()) as { user: identity.IdentityUser }).user.id;
}

async function activate(h: Harness, id: string, body: Record<string, unknown> = { trigger: "participation.link" }) {
  const init = jsonBody(internal(), "POST", body);
  init.headers = { ...(init.headers as Record<string, string>), "x-dub-user-id": h.adminId };
  const res = await h.app.request(`/internal/users/${id}/activate`, init);
  return { status: res.status, json: (await res.json()) as identity.ActivateInvitedUserResponse };
}

describe("activate invited (POST /internal/users/:id/activate)", () => {
  it("invited -> active with a write-ahead sync audit naming the trigger and actor", async () => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    const res = await activate(h, id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ dryRun: false, activated: true, previousStatus: "invited", status: "active" });
    expect((await h.repo.getUser(id))!.status).toBe("active");
    const audit = h.audit.syncCalls.find((a) => a.action === "identity.user.provisioned" && a.resourceId === id);
    expect(audit?.details).toEqual({ via: "member-roster", trigger: "participation.link" });
    expect(audit?.actorId).toBe(h.adminId);
  });

  it("is idempotent: a second call is a no-op and writes no audit", async () => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    await activate(h, id);
    const before = h.audit.syncCalls.length;
    const res = await activate(h, id);
    expect(res.json).toEqual({ dryRun: false, activated: false, previousStatus: "active", status: "active" });
    expect(h.audit.syncCalls.length).toBe(before);
  });

  it.each(["disabled", "rejected"] as const)("never overrides %s", async (st) => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    await h.repo.updateUser(id, { status: st }, "2026-08-09T00:00:00.000Z");
    const res = await activate(h, id);
    expect(res.json).toEqual({ dryRun: false, activated: false, previousStatus: st, status: st });
    expect((await h.repo.getUser(id))!.status).toBe(st);
    expect(h.audit.syncCalls.length).toBe(0);
  });

  it("compare-and-set: a disable landing after the read is not overwritten", async () => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    const realGet = h.repo.getUser.bind(h.repo);
    let first = true;
    h.repo.getUser = async (uid: string) => {
      const row = await realGet(uid);
      if (first && uid === id) {
        first = false;
        await h.repo.updateUser(id, { status: "disabled" }, "2026-08-09T00:00:00.000Z");
      }
      return row;
    };
    const res = await activate(h, id);
    expect(res.json.activated).toBe(false);
    expect((await realGet(id))!.status).toBe("disabled");
  });

  it("dryRun reports without writing", async () => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    const res = await activate(h, id, { trigger: "member.backfill", dryRun: true });
    expect(res.json).toEqual({ dryRun: true, activated: true, previousStatus: "invited", status: "invited" });
    expect((await h.repo.getUser(id))!.status).toBe("invited");
    expect(h.audit.syncCalls.length).toBe(0);
  });

  it("fail-close: an audit outage leaves the user invited", async () => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    h.audit.failSync = true;
    const res = await activate(h, id);
    expect(res.status).toBe(502);
    expect((await h.repo.getUser(id))!.status).toBe("invited");
  });

  it("404 for an unknown user, 400 for a missing/invalid trigger", async () => {
    const h = await makeHarness();
    expect((await activate(h, "user_nope")).status).toBe(404);
    const id = await invite(h, "inv@developershub.jp");
    expect((await activate(h, id, {})).status).toBe(400);
    expect((await activate(h, id, { trigger: "Bad Trigger!" })).status).toBe(400);
  });

  it("is internal-only: an external admin call is 403", async () => {
    const h = await makeHarness();
    const id = await invite(h, "inv@developershub.jp");
    const res = await h.app.request(`/internal/users/${id}/activate`, jsonBody(asUser(h.adminId), "POST", { trigger: "x" }));
    expect(res.status).toBe(403);
    expect((await h.repo.getUser(id))!.status).toBe("invited");
  });
});

describe("activateIfInvited over D1 SQL (compare-and-set)", () => {
  const migration = (f: string) => readFileSync(new URL(`../../../infra/d1/migrations/identity/${f}`, import.meta.url), "utf8");
  const TS = "2026-11-02T00:00:00.000Z";

  it("flips only an invited row and reports whether it did", async () => {
    const { d1, raw } = makeOutboxD1();
    raw.exec(migration("0001_init.sql"));
    raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
    raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG_ID}', 'DevHub', '${TS}')`);
    const repo = new D1IdentityRepo(createDbClient(d1, { namespace: "identity" }));
    const mk = (id: string, status: identity.UserStatus) =>
      repo.createUser({ id, orgId: ORG_ID, email: `${id}@x.jp`, displayName: id, furigana: null, githubLogin: null, avatarUrl: null, status, source: "manual", createdAt: TS, updatedAt: TS });
    await mk("u_inv", "invited");
    await mk("u_off", "disabled");

    expect(await repo.activateIfInvited("u_inv", "2026-11-03T00:00:00.000Z")).toBe(true);
    expect(await repo.activateIfInvited("u_inv", "2026-11-04T00:00:00.000Z")).toBe(false);
    expect(await repo.activateIfInvited("u_off", "2026-11-03T00:00:00.000Z")).toBe(false);
    expect(raw.prepare("SELECT id, status, updated_at FROM identity_users ORDER BY id").all()).toEqual([
      { id: "u_inv", status: "active", updated_at: "2026-11-03T00:00:00.000Z" },
      { id: "u_off", status: "disabled", updated_at: TS },
    ]);
  });
});
