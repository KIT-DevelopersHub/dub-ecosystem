import { describe, it, expect } from "vitest";
import { createApp, makeDeps, fakeAuthz, call } from "./harness";
import type { identity } from "@dub/types";

describe("member-service HTTP surface", () => {
  // /health is INTERNAL in POLICY_TABLE, not PUBLIC: its only caller is app-health-monitor,
  // which probes over the SVC_MEMBER binding with x-dub-internal attached.
  it("health answers a service-to-service probe, and 403s without the marker", async () => {
    const app = createApp(makeDeps());
    const probe = await call(app, "GET", "/health", { userId: null, internal: true });
    expect(probe.status).toBe(200);
    expect(probe.json.service).toBe("member-service");
    const outside = await call(app, "GET", "/health", { userId: null });
    expect(outside.status).toBe(403);
    expect(outside.json.error.details.reason).toBe("internal_only");
  });

  it("requires auth on /members/*", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/members/overview", { userId: null });
    expect(res.status).toBe(401);
  });

  it("read requires 運営メンバー=閲覧", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>()) }));
    const res = await call(app, "GET", "/members/overview");
    expect(res.status).toBe(403);
  });

  it("write requires 運営メンバー=編集 (閲覧 + the domain read key is not enough)", async () => {
    const app = createApp(
      makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>(["identity:read", "app:members:view"])) }),
    );
    const res = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    expect(res.status).toBe(403);
  });

  // ── policy layer: the 運営メンバー app's 3 段階 gates writes server-side ─────────────
  it("403s a write when ロール管理 set 運営メンバー to 閲覧 (even with identity:admin)", async () => {
    const viewer = new Set<identity.PermissionKey>(["identity:read", "identity:admin", "app:members:view"]);
    const app = createApp(makeDeps({ authz: fakeAuthz(viewer) }));
    expect((await call(app, "GET", "/members/overview")).status).toBe(200); // 閲覧 still reads
    expect((await call(app, "POST", "/members/teams", { body: { name: "会場" } })).status).toBe(403);
    expect((await call(app, "DELETE", "/members/teams/team_x")).status).toBe(403);
  });

  it("403s a write when 運営メンバー is 無効", async () => {
    const off = new Set<identity.PermissionKey>(["identity:read", "identity:admin"]);
    const app = createApp(makeDeps({ authz: fakeAuthz(off) }));
    expect((await call(app, "POST", "/members/teams", { body: { name: "会場" } })).status).toBe(403);
  });

  it("運営メンバー=編集 does NOT unlock 参加届の反映確定 (per-app, not per-service)", async () => {
    const membersOnly = new Set<identity.PermissionKey>([
      "identity:read",
      "identity:admin",
      "app:members:view",
      "app:members:edit",
    ]);
    const app = createApp(makeDeps({ authz: fakeAuthz(membersOnly) }));
    // 運営メンバー writes pass...
    expect((await call(app, "POST", "/members/teams", { body: { name: "会場" } })).status).toBe(201);
    // ...while the 参加届 app is still 無効 for this role.
    expect((await call(app, "POST", "/members/participation/part_x/resolve", { body: { action: "skip" } })).status).toBe(403);
  });

  it("GET /members/teams returns the canonical team list with a derived unique key", async () => {
    const app = createApp(makeDeps());
    await call(app, "POST", "/members/teams", { body: { name: "Venue Ops", color: "#4f46e5" } });
    // same-name team -> key auto-deduped
    await call(app, "POST", "/members/teams", { body: { name: "Venue Ops" } });
    const res = await call(app, "GET", "/members/teams");
    expect(res.status).toBe(200);
    expect(res.json.teams).toHaveLength(2);
    const keys = res.json.teams.map((t: any) => t.key);
    expect(keys).toContain("venue-ops");
    expect(new Set(keys).size).toBe(2); // unique
    expect(res.json.teams[0]).toHaveProperty("color");
  });

  it("full flow: create teams + member, group in overview, edit, delete", async () => {
    const app = createApp(makeDeps());

    // create two teams
    const t1 = await call(app, "POST", "/members/teams", { body: { name: "会場", description: "会場運営" } });
    expect(t1.status).toBe(201);
    const t2 = await call(app, "POST", "/members/teams", { body: { name: "広報" } });
    expect(t2.status).toBe(201);
    const teamA = t1.json.id as string;
    const teamB = t2.json.id as string;

    // create a member in both teams
    const m = await call(app, "POST", "/members/people", {
      body: { name: "山田太郎", roleTitle: "会場リーダー", status: "added", teamIds: [teamA, teamB], contact: "yamada@example.com" },
    });
    expect(m.status).toBe(201);
    expect(m.json.version).toBe(1);
    expect(m.json.teamIds.sort()).toEqual([teamA, teamB].sort());
    const memberId = m.json.id as string;

    // overview groups everything
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.status).toBe(200);
    expect(ov.json.teams).toHaveLength(2);
    expect(ov.json.members).toHaveLength(1);
    expect(ov.json.members[0].teamIds.sort()).toEqual([teamA, teamB].sort());

    // edit: change status + drop teamB (optimistic version echo)
    const upd = await call(app, "PATCH", `/members/people/${memberId}`, {
      body: { status: "invited", teamIds: [teamA], version: 1 },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.status).toBe("invited");
    expect(upd.json.teamIds).toEqual([teamA]);
    expect(upd.json.version).toBe(2);

    // stale version -> 409
    const stale = await call(app, "PATCH", `/members/people/${memberId}`, { body: { status: "declined", version: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("MEMBER_VERSION_CONFLICT");

    // delete member (soft archive) -> gone from overview
    const del = await call(app, "DELETE", `/members/people/${memberId}`);
    expect(del.status).toBe(200);
    const ov2 = await call(app, "GET", "/members/overview");
    expect(ov2.json.members).toHaveLength(0);
  });

  it("学科(department)・学年(grade) round-trip as their own fields on create/edit", async () => {
    const app = createApp(makeDeps());
    const created = await call(app, "POST", "/members/people", {
      body: { name: "田中", status: "added", teamIds: [], department: "情報工学科", grade: "3年" },
    });
    expect(created.status).toBe(201);
    expect(created.json.department).toBe("情報工学科");
    expect(created.json.grade).toBe("3年");
    const memberId = created.json.id as string;

    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members[0].department).toBe("情報工学科");
    expect(ov.json.members[0].grade).toBe("3年");

    // edit only 学年, leave 学科 untouched; blanks clear the field
    const upd = await call(app, "PATCH", `/members/people/${memberId}`, {
      body: { grade: "M1", version: 1 },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.grade).toBe("M1");
    expect(upd.json.department).toBe("情報工学科");

    const cleared = await call(app, "PATCH", `/members/people/${memberId}`, {
      body: { department: "", version: 2 },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json.department).toBeNull();
  });

  it("rejects invalid status and unknown teamIds", async () => {
    const app = createApp(makeDeps());
    const bad = await call(app, "POST", "/members/people", { body: { name: "A", status: "bogus", teamIds: [] } });
    expect(bad.status).toBe(400);
    const unknownTeam = await call(app, "POST", "/members/people", {
      body: { name: "A", status: "added", teamIds: ["team_missing"] },
    });
    expect(unknownTeam.status).toBe(404);
  });

  it("deleting a team detaches it from members but keeps the members", async () => {
    const app = createApp(makeDeps());
    const t = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    const teamId = t.json.id as string;
    const m = await call(app, "POST", "/members/people", { body: { name: "B", status: "added", teamIds: [teamId] } });
    expect(m.json.teamIds).toEqual([teamId]);
    const del = await call(app, "DELETE", `/members/teams/${teamId}`);
    expect(del.status).toBe(200);
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.teams).toHaveLength(0);
    expect(ov.json.members).toHaveLength(1);
    expect(ov.json.members[0].teamIds).toEqual([]);
  });
});

describe("member-service identity linking (#1)", () => {
  it("new members start unlinked (identityUserId=null)", async () => {
    const app = createApp(makeDeps());
    const m = await call(app, "POST", "/members/people", { body: { name: "A", status: "added", teamIds: [] } });
    expect(m.json.identityUserId).toBeNull();
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.json.members[0].identityUserId).toBeNull();
  });

  it("links a member to an identity account and looks it up in reverse", async () => {
    const app = createApp(makeDeps());
    const m = await call(app, "POST", "/members/people", { body: { name: "山田", status: "added", teamIds: [] } });
    const id = m.json.id as string;

    const linked = await call(app, "POST", `/members/people/${id}/identity-link`, {
      body: { identityUserId: "usr_yamada", version: m.json.version },
    });
    expect(linked.status).toBe(200);
    expect(linked.json.identityUserId).toBe("usr_yamada");
    expect(linked.json.version).toBe(m.json.version + 1);

    const rev = await call(app, "GET", "/members/people/by-identity/usr_yamada");
    expect(rev.status).toBe(200);
    expect(rev.json.member.id).toBe(id);

    const missing = await call(app, "GET", "/members/people/by-identity/usr_nobody");
    expect(missing.json.member).toBeNull();
  });

  it("unlinks via identity-link with null and via PATCH", async () => {
    const app = createApp(makeDeps());
    const m = await call(app, "POST", "/members/people", { body: { name: "B", status: "added", teamIds: [] } });
    const id = m.json.id as string;
    const linked = await call(app, "POST", `/members/people/${id}/identity-link`, { body: { identityUserId: "usr_b", version: m.json.version } });
    const unlinked = await call(app, "POST", `/members/people/${id}/identity-link`, { body: { identityUserId: null, version: linked.json.version } });
    expect(unlinked.json.identityUserId).toBeNull();
    // PATCH can also set the link
    const relinked = await call(app, "PATCH", `/members/people/${id}`, { body: { identityUserId: "usr_b2", version: unlinked.json.version } });
    expect(relinked.json.identityUserId).toBe("usr_b2");
  });

  it("rejects linking the same identity account to two members (409)", async () => {
    const app = createApp(makeDeps());
    const m1 = await call(app, "POST", "/members/people", { body: { name: "C1", status: "added", teamIds: [] } });
    const m2 = await call(app, "POST", "/members/people", { body: { name: "C2", status: "added", teamIds: [] } });
    await call(app, "POST", `/members/people/${m1.json.id}/identity-link`, { body: { identityUserId: "usr_dup", version: m1.json.version } });
    const clash = await call(app, "POST", `/members/people/${m2.json.id}/identity-link`, { body: { identityUserId: "usr_dup", version: m2.json.version } });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe("MEMBER_IDENTITY_ALREADY_LINKED");
  });

  it("link honors optimistic concurrency (stale version -> 409)", async () => {
    const app = createApp(makeDeps());
    const m = await call(app, "POST", "/members/people", { body: { name: "D", status: "added", teamIds: [] } });
    const stale = await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId: "usr_d", version: 999 } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("MEMBER_VERSION_CONFLICT");
  });

  it("re-linking the SAME member to its current account is idempotent (no conflict)", async () => {
    const app = createApp(makeDeps());
    const m = await call(app, "POST", "/members/people", { body: { name: "E", status: "added", teamIds: [] } });
    const l1 = await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId: "usr_e", version: m.json.version } });
    const l2 = await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId: "usr_e", version: l1.json.version } });
    expect(l2.status).toBe(200);
    expect(l2.json.identityUserId).toBe("usr_e");
  });
});
