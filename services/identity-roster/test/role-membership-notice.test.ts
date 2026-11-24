// Every path that changes a user's effective role membership tells drive-share-service (via the
// freeq outbox), so a role's Drive共有 grants and ミーティング invitations follow people who join or
// leave the role later. The sink is best-effort: a failing one never fails the role change.
import { describe, it, expect } from "vitest";
import { identity } from "@dub/types";
import type { identity as identityTypes } from "@dub/types";
import { makeOutboxD1 } from "./outbox-d1";
import { createRoleMembershipSink } from "../src/sinks";
import type { Env } from "../src/env";
import { makeHarness, asUser, internal, jsonBody, ORG_ID, type Harness } from "./harness";

const TEAM = { id: "role_auto_team_team_a", name: "チーム: 広報" };

const notices = (h: Harness) => h.membership.notices.map((n) => `${n.change}:${n.reason}:${n.userId}:${[...n.roleIds].sort().join(",")}`);

async function newRole(h: Harness, name: string): Promise<string> {
  const res = await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name, permissions: [] }));
  return ((await res.json()) as { id: string }).id;
}

describe("role membership notices", () => {
  it("assign -> added, revoke -> removed (for that role only)", async () => {
    const h = await makeHarness();
    const role = await newRole(h, "A班");
    const res = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: role }));
    const { id } = (await res.json()) as { id: string };
    await h.app.request(`/identity/users/${h.memberId}/roles/${id}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(notices(h)).toEqual([`added:assign:${h.memberId}:${role}`, `removed:revoke:${h.memberId}:${role}`]);
    expect(h.membership.notices[0]).toMatchObject({ orgId: ORG_ID });
  });

  it("a rejected assignment (already held) sends nothing", async () => {
    const h = await makeHarness();
    await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: h.memberRoleId }));
    expect(h.membership.notices).toEqual([]);
  });

  it("team auto-roles (名簿 sync): added / removed per change, nothing when unchanged", async () => {
    const h = await makeHarness();
    const put = (roles: identityTypes.ManagedRoleSpec[]) =>
      h.app.request(`/internal/users/${h.memberId}/managed-roles`, jsonBody({ headers: { ...internal().headers, "x-dub-user-id": h.adminId } }, "PUT", { roles }));
    await put([TEAM]);
    await put([TEAM]);
    await put([]);
    expect(notices(h)).toEqual([`added:managed-sync:${h.memberId}:${TEAM.id}`, `removed:managed-sync:${h.memberId}:${TEAM.id}`]);
  });

  it("a team dropped from the catalog removes its auto members", async () => {
    const h = await makeHarness();
    await h.app.request(`/internal/users/${h.memberId}/managed-roles`, jsonBody({ headers: { ...internal().headers, "x-dub-user-id": h.adminId } }, "PUT", { roles: [TEAM] }));
    h.membership.notices = [];
    await h.app.request("/internal/managed-roles", jsonBody(internal(), "PUT", { roles: [] }));
    expect(notices(h)).toEqual([`removed:managed-catalog:${h.memberId}:${TEAM.id}`]);
  });

  it("deleting a role removes every holder", async () => {
    const h = await makeHarness();
    const role = await newRole(h, "A班");
    await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: role }));
    h.membership.notices = [];
    await h.app.request(`/identity/roles/${role}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(notices(h)).toEqual([`removed:role-delete:${h.memberId}:${role}`]);
  });

  it("disable -> removed for all roles; re-enable -> added; a rename sends nothing", async () => {
    const h = await makeHarness();
    const patch = (body: unknown) => h.app.request(`/identity/users/${h.memberId}`, jsonBody(asUser(h.adminId), "PATCH", body));
    await patch({ displayName: "Renamed" });
    await patch({ status: "disabled" });
    await patch({ status: "active" });
    expect(notices(h)).toEqual([`removed:deactivate:${h.memberId}:${h.memberRoleId}`, `added:activate:${h.memberId}:${h.memberRoleId}`]);
  });

  it("an invited user counts once activated (the roles given at invite reach them then)", async () => {
    const h = await makeHarness();
    const role = await newRole(h, "A班");
    const inv = await h.app.request("/identity/users/invite", jsonBody(asUser(h.adminId), "POST", { email: "new@developershub.jp", roleIds: [role] }));
    const id = ((await inv.json()) as { user: identityTypes.IdentityUser }).user.id;
    expect(h.membership.notices).toEqual([]); // invited: not a member yet

    const init = jsonBody(internal(), "POST", { trigger: "participation.link" });
    init.headers = { ...(init.headers as Record<string, string>), "x-dub-user-id": h.adminId };
    await h.app.request(`/internal/users/${id}/activate`, init);
    await h.app.request(`/internal/users/${id}/activate`, init); // idempotent: no second notice
    expect(notices(h)).toEqual([`added:activate:${id}:${role}`]);
  });

  it("offboarding removes every role", async () => {
    const h = await makeHarness();
    await h.app.request(`/identity/users/${h.memberId}/offboard`, { ...asUser(h.adminId), method: "POST" });
    expect(notices(h)).toEqual([`removed:offboard:${h.memberId}:${h.memberRoleId}`]);
  });

  it("a throwing sink never fails the role change", async () => {
    const h = await makeHarness();
    h.membership.changed = async () => {
      throw new Error("outbox down");
    };
    const res = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: h.adminRoleId }));
    expect(res.status).toBe(201);
  });
});

describe("createRoleMembershipSink (freeq outbox)", () => {
  it("writes one RoleMembershipChangedV1 row on the role-membership topic, deduped by id", async () => {
    const { d1, raw } = makeOutboxD1();
    let n = 0;
    const sink = createRoleMembershipSink({ OUTBOX_DB: d1 } as unknown as Env, { now: () => "2026-11-24T00:00:00.000Z", newId: (p) => `${p}_${++n}` });
    await sink.changed({ orgId: ORG_ID, userId: "user_1", change: "added", roleIds: ["role_a", "role_a", "role_b"], reason: "assign" });
    await sink.changed({ orgId: ORG_ID, userId: "user_1", change: "added", roleIds: [], reason: "assign" }); // nothing to follow

    const rows = raw.prepare("SELECT id, topic, payload, status FROM freeq_outbox").all() as { id: string; topic: string; payload: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "rm_1", topic: identity.ROLE_MEMBERSHIP_TOPIC, status: "pending" });
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "identity.role_membership.changed",
      version: 1,
      id: "rm_1",
      occurredAt: "2026-11-24T00:00:00.000Z",
      orgId: ORG_ID,
      userId: "user_1",
      change: "added",
      roleIds: ["role_a", "role_b"],
      reason: "assign",
    });
  });

  it("no OUTBOX_DB: a no-op; a failing insert is swallowed", async () => {
    const none = createRoleMembershipSink({} as Env, { now: () => "t", newId: (p) => p });
    await expect(none.changed({ orgId: ORG_ID, userId: "u", change: "removed", roleIds: ["r"], reason: "revoke" })).resolves.toBeUndefined();
    const broken = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("d1 down"); } }) }) };
    const failing = createRoleMembershipSink({ OUTBOX_DB: broken } as unknown as Env, { now: () => "t", newId: (p) => p });
    await expect(failing.changed({ orgId: ORG_ID, userId: "u", change: "removed", roleIds: ["r"], reason: "revoke" })).resolves.toBeUndefined();
  });
});

describe("createRoleMembershipSink: immediate delivery", () => {
  function fakeDriveShare(status: number) {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const svc = {
      async fetch(url: string, init: RequestInit) {
        calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status });
      },
    };
    return { svc, calls };
  }

  it("POSTs the same message to drive-share in the background and marks the outbox row done", async () => {
    const { d1, raw } = makeOutboxD1();
    const ds = fakeDriveShare(200);
    const work: Promise<unknown>[] = [];
    const sink = createRoleMembershipSink({ OUTBOX_DB: d1, SVC_DRIVE_SHARE: ds.svc } as unknown as Env, { now: () => "t", newId: (p) => `${p}_1`, background: (p) => void work.push(p) });
    await sink.changed({ orgId: ORG_ID, userId: "user_1", change: "added", roleIds: ["role_a"], reason: "assign" });
    await Promise.all(work);

    expect(ds.calls).toHaveLength(1);
    expect(ds.calls[0]!.url).toBe("https://drive-share/internal/role-membership");
    expect(ds.calls[0]!.headers["x-dub-internal"]).toBe("1");
    expect(ds.calls[0]!.body).toMatchObject({ id: "rm_1", change: "added", roleIds: ["role_a"] });
    expect(raw.prepare("SELECT status FROM freeq_outbox WHERE id = 'rm_1'").get()).toMatchObject({ status: "done" });
  });

  it("a failed direct delivery leaves the row pending for freeq-drain", async () => {
    const { d1, raw } = makeOutboxD1();
    const work: Promise<unknown>[] = [];
    const sink = createRoleMembershipSink({ OUTBOX_DB: d1, SVC_DRIVE_SHARE: fakeDriveShare(503).svc } as unknown as Env, { now: () => "t", newId: (p) => `${p}_1`, background: (p) => void work.push(p) });
    await sink.changed({ orgId: ORG_ID, userId: "user_1", change: "removed", roleIds: ["role_a"], reason: "revoke" });
    await Promise.all(work);
    expect(raw.prepare("SELECT status FROM freeq_outbox WHERE id = 'rm_1'").get()).toMatchObject({ status: "pending" });
  });
});
