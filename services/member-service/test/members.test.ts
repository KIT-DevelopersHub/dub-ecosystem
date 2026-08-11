import { describe, it, expect } from "vitest";
import { createApp, makeDeps, fakeAuthz, call } from "./harness";
import type { identity } from "@dub/types";

describe("member-service HTTP surface", () => {
  it("health is open", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/health", { userId: null });
    expect(res.status).toBe(200);
    expect(res.json.service).toBe("member-service");
  });

  it("requires auth on /members/*", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/members/overview", { userId: null });
    expect(res.status).toBe(401);
  });

  it("read requires identity:read", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>()) }));
    const res = await call(app, "GET", "/members/overview");
    expect(res.status).toBe(403);
  });

  it("write requires identity:admin", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>(["identity:read"])) }));
    const res = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    expect(res.status).toBe(403);
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
