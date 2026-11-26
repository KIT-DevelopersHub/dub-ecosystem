// Every path that changes a user's effective role membership calls drive-share-service synchronously
// (no queue), so a role's Drive共有 grants and ミーティング invitations follow people who join or leave
// the role right then. A failing call never fails the role change: it comes back as
// propagationWarnings (body + header) and an audit record.
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

  it("a drive-share failure never fails the role change; it is surfaced in the response and the audit log", async () => {
    const h = await makeHarness();
    h.membership.outcome = { ok: false, message: "Drive共有・ミーティングへの反映に失敗しました（HTTP 503）。" };
    const role = await newRole(h, "A班");

    const res = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: role }));
    expect(res.status).toBe(201);
    expect(res.headers.get(identity.PROPAGATION_WARNING_HEADER)).toBe("1");
    const body = (await res.json()) as { roleId: string; propagationWarnings: identityTypes.RolePropagationWarning[] };
    expect(body.roleId).toBe(role); // the assignment is committed
    expect(body.propagationWarnings).toEqual([{ userId: h.memberId, change: "added", roleIds: [role], reason: "assign", message: "Drive共有・ミーティングへの反映に失敗しました（HTTP 503）。" }]);
    expect((await h.repo.listAssignmentsByUser(h.memberId, ORG_ID)).some((a) => a.roleId === role)).toBe(true);
    expect(h.audit.published.find((a) => a.action === "identity.role.propagation_failed")).toMatchObject({ result: "failure", resourceId: h.memberId });

    // 204 responses carry the header only.
    const { id } = { id: (await h.repo.listAssignmentsByUser(h.memberId, ORG_ID)).find((a) => a.roleId === role)!.id };
    const rv = await h.app.request(`/identity/users/${h.memberId}/roles/${id}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(rv.status).toBe(204);
    expect(rv.headers.get(identity.PROPAGATION_WARNING_HEADER)).toBe("1");
  });

  it("a throwing sink is treated like a failure, never a 500", async () => {
    const h = await makeHarness();
    h.membership.changed = async () => {
      throw new Error("boom");
    };
    const res = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: h.adminRoleId }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { propagationWarnings: unknown[] }).propagationWarnings).toHaveLength(1);
  });

  it("success adds nothing to the response", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: h.adminRoleId }));
    expect(res.headers.get(identity.PROPAGATION_WARNING_HEADER)).toBeNull();
    expect(await res.json()).not.toHaveProperty("propagationWarnings");
  });
});

describe("createRoleMembershipSink (synchronous call to drive-share)", () => {
  function fakeDriveShare(answer: { status?: number; body?: unknown; hang?: boolean }) {
    const calls: { url: string; headers: Record<string, string>; body: identityTypes.RoleMembershipChangedV1 }[] = [];
    const svc = {
      async fetch(url: string, init: RequestInit) {
        calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        if (answer.hang) {
          return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        return new Response(JSON.stringify(answer.body ?? { complete: true, problems: [] }), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
      },
    };
    return { svc, calls };
  }
  const notice = { orgId: ORG_ID, userId: "user_1", change: "added" as const, roleIds: ["role_a", "role_a", "role_b"], reason: "assign" as const };
  const ids = { now: () => "2026-11-24T00:00:00.000Z", newId: (p: string) => `${p}_1` };

  it("POSTs the change to drive-share and waits for the answer — no outbox row is written", async () => {
    const { d1, raw } = makeOutboxD1();
    const ds = fakeDriveShare({});
    const sink = createRoleMembershipSink({ OUTBOX_DB: d1, SVC_DRIVE_SHARE: ds.svc } as unknown as Env, ids);
    expect(await sink.changed(notice)).toEqual({ ok: true });
    expect(ds.calls).toHaveLength(1);
    expect(ds.calls[0]!.url).toBe(`https://drive-share${identity.ROLE_MEMBERSHIP_PATH}`);
    expect(ds.calls[0]!.headers["x-dub-internal"]).toBe("1");
    expect(ds.calls[0]!.body).toEqual({
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
    expect(raw.prepare("SELECT count(*) AS n FROM freeq_outbox").get()).toMatchObject({ n: 0 });
  });

  it("an HTTP error, an unfinished follow, or a timeout is a failure outcome with a Japanese message", async () => {
    const http = createRoleMembershipSink({ SVC_DRIVE_SHARE: fakeDriveShare({ status: 503 }).svc } as unknown as Env, ids);
    expect(await http.changed(notice)).toMatchObject({ ok: false, message: expect.stringContaining("HTTP 503") });

    const partial = createRoleMembershipSink({ SVC_DRIVE_SHARE: fakeDriveShare({ body: { complete: false, problems: ["ミーティングの招待の一部が時間内に終わりませんでした。"] } }).svc } as unknown as Env, ids);
    expect(await partial.changed(notice)).toMatchObject({ ok: false, message: "ミーティングの招待の一部が時間内に終わりませんでした。" });

    const slow = createRoleMembershipSink({ SVC_DRIVE_SHARE: fakeDriveShare({ hang: true }).svc } as unknown as Env, { ...ids, timeoutMs: 20 });
    expect(await slow.changed(notice)).toMatchObject({ ok: false, message: expect.stringContaining("秒以内に終わりませんでした") });
  });

  it("#908: a failed / timed-out / retryable call is queued once on the freeq outbox for freeq-drain to redeliver", async () => {
    const rows = (raw: ReturnType<typeof makeOutboxD1>["raw"]) =>
      raw.prepare("SELECT id, topic, payload, status FROM freeq_outbox").all() as { id: string; topic: string; payload: string; status: string }[];

    const a = makeOutboxD1();
    const http = createRoleMembershipSink({ OUTBOX_DB: a.d1, SVC_DRIVE_SHARE: fakeDriveShare({ status: 503 }).svc } as unknown as Env, ids);
    expect(await http.changed(notice)).toMatchObject({ ok: false, message: expect.stringContaining("自動で再試行します") });
    await http.changed(notice); // same message id: INSERT OR IGNORE
    const queued = rows(a.raw);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: "rm_1", topic: identity.ROLE_MEMBERSHIP_TOPIC, status: "pending" });
    expect(JSON.parse(queued[0]!.payload)).toMatchObject({ type: "identity.role_membership.changed", id: "rm_1", roleIds: ["role_a", "role_b"] });

    const b = makeOutboxD1();
    const slow = createRoleMembershipSink({ OUTBOX_DB: b.d1, SVC_DRIVE_SHARE: fakeDriveShare({ hang: true }).svc } as unknown as Env, { ...ids, timeoutMs: 20 });
    await slow.changed(notice);
    expect(rows(b.raw)).toHaveLength(1);

    const c = makeOutboxD1();
    const retryable = createRoleMembershipSink({ OUTBOX_DB: c.d1, SVC_DRIVE_SHARE: fakeDriveShare({ body: { complete: false, retry: true, problems: ["途中"] } }).svc } as unknown as Env, ids);
    await retryable.changed(notice);
    expect(rows(c.raw)).toHaveLength(1);
  });

  it("#908: an unfinished follow a retry cannot fix (no calendar scope / refused address) is reported, not queued", async () => {
    const { d1, raw } = makeOutboxD1();
    const sink = createRoleMembershipSink({ OUTBOX_DB: d1, SVC_DRIVE_SHARE: fakeDriveShare({ body: { complete: false, problems: ["再接続してください。"] } }).svc } as unknown as Env, ids);
    expect(await sink.changed(notice)).toEqual({ ok: false, message: "再接続してください。" });
    expect(raw.prepare("SELECT count(*) AS n FROM freeq_outbox").get()).toMatchObject({ n: 0 });
  });

  it("no binding / no roles: nothing is sent, ok", async () => {
    const none = createRoleMembershipSink({} as Env, ids);
    expect(await none.changed(notice)).toEqual({ ok: true });
    const ds = fakeDriveShare({});
    const empty = createRoleMembershipSink({ SVC_DRIVE_SHARE: ds.svc } as unknown as Env, ids);
    expect(await empty.changed({ ...notice, roleIds: [] })).toEqual({ ok: true });
    expect(ds.calls).toEqual([]);
  });
});
