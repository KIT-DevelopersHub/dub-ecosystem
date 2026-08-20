// #5: POST /identity/users/sync-email-routing/preview — READ-ONLY diff of what the
// apply would change. Same reconciliation as the sync, but performs no writes.
import { describe, it, expect } from "vitest";
import { makeHarness, asUser, jsonBody, ORG_ID } from "./harness";
import type { Harness } from "./harness";
import type { EmailRoutingSyncPreview } from "../src/dto";
import type { UserRow } from "../src/repo/types";

const DOMAIN = "developershub.jp";
const addr = (localPart: string, enabled = true) => ({ address: `${localPart}@${DOMAIN}`, destination: "fwd@example.com", enabled });

async function preview(h: Harness, userId: string, addresses: unknown[]) {
  return h.app.request("/identity/users/sync-email-routing/preview", jsonBody(asUser(userId), "POST", { addresses }));
}

function mkUser(id: string, email: string, over: Partial<UserRow> = {}): UserRow {
  return { id, orgId: ORG_ID, email, displayName: id, githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: "t", updatedAt: "t", ...over };
}

describe("sync-email-routing preview (#5)", () => {
  it("requires identity:admin", async () => {
    const h = await makeHarness();
    const res = await preview(h, h.memberId, [addr("account")]);
    expect(res.status).toBe(403);
  });

  it("classifies add / reactivate / relink / deactivate and projects apply counts", async () => {
    const h = await makeHarness();
    // seed roster state:
    await h.repo.createUser(mkUser("u_reactivate", `back@${DOMAIN}`, { status: "disabled", source: "email-routing" }));
    await h.repo.createUser(mkUser("u_relink", `manual@${DOMAIN}`, { source: "manual" }));
    await h.repo.createUser(mkUser("u_gone", `gone@${DOMAIN}`, { source: "email-routing", status: "active" }));

    // incoming Email Routing set: a brand-new address, the reactivating one, and the manual one.
    const res = await preview(h, h.adminId, [addr("brandnew"), addr("back"), addr("manual")]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EmailRoutingSyncPreview;

    expect(body.toAdd.map((r) => r.email)).toEqual([`brandnew@${DOMAIN}`]);
    expect(body.toReactivate.map((r) => r.userId)).toEqual(["u_reactivate"]);
    expect(body.toRelink.map((r) => r.userId)).toEqual(["u_relink"]);
    // u_gone is an owned email-routing row not in the incoming set -> would be disabled.
    expect(body.toDeactivate.map((r) => r.userId)).toEqual(["u_gone"]);
    expect(body.projected).toEqual({ added: 1, updated: 2, deactivated: 1, total: 3 });
  });

  it("is READ-ONLY — nothing is mutated by a preview", async () => {
    const h = await makeHarness();
    await h.repo.createUser(mkUser("u_gone", `gone@${DOMAIN}`, { source: "email-routing", status: "active" }));
    await preview(h, h.adminId, [addr("brandnew")]);

    // no new row created, and the owned row is still active (not disabled).
    expect(await h.repo.getUserByEmail(ORG_ID, `brandnew@${DOMAIN}`)).toBeNull();
    expect((await h.repo.getUser("u_gone"))!.status).toBe("active");
  });

  it("does not deactivate an admin email-routing row (adminKept, guarded)", async () => {
    const h = await makeHarness();
    // make the admin an email-routing row, then preview an empty set.
    await h.repo.updateUser(h.adminId, { source: "email-routing" }, "t");
    const res = await preview(h, h.adminId, []);
    const body = (await res.json()) as EmailRoutingSyncPreview;
    expect(body.adminKept.map((r) => r.userId)).toContain(h.adminId);
    expect(body.toDeactivate.map((r) => r.userId)).not.toContain(h.adminId);
  });

  it("rejects a malformed address before producing any diff", async () => {
    const h = await makeHarness();
    const res = await preview(h, h.adminId, [{ address: "not-an-email" }]);
    expect(res.status).toBe(400);
  });
});
