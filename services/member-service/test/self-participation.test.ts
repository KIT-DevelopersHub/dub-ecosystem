// Self 参加届 (アカウント設定 → 参加情報): the signed-in user reads/edits their OWN 参加届,
// resolved via the identity link to their member_people row. Reached through the gateway
// at GET/POST /api/v1/me/participation, forwarded here as an internal s2s call
// (x-dub-internal + the caller's identity x-dub-user-id). Drives the real Hono app over
// the in-memory repo.
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, call } from "./harness";

const IDU = "idu_self"; // the caller's identity userId (forwarded as x-dub-user-id)

describe("member-service self 参加届 (/members/internal/me/participation)", () => {
  // INTERNAL in POLICY_TABLE: 403 internal_only (was a hand-rolled 404). api-gateway still
  // 404s the /members/internal/ prefix at the edge, so reachability is unchanged.
  it("403s without x-dub-internal (route never exposed externally)", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/members/internal/me/participation", { userId: IDU });
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("internal_only");
  });

  // INTERNAL does not guarantee an actor, so the 401 is the handler's own `reqCtx` check —
  // this route acts on the caller's linked roster row and cannot run without one.
  it("401s without a user id even when internal", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/members/internal/me/participation", { userId: null, internal: true });
    expect(res.status).toBe(401);
  });

  it("returns an all-null 参加届 when the caller has no linked roster entry", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/members/internal/me/participation", { userId: IDU, internal: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      lastName: null,
      firstName: null,
      lastNameKana: null,
      firstNameKana: null,
      lastNameRomaji: null,
      firstNameRomaji: null,
      schoolEmail: null,
      gmail: null,
      phone: null,
      grade: null,
      department: null,
      rosterNumber: null,
      studentNumber: null,
      desiredActivity: null,
      note: null,
      contact: null,
      operations: null,
    });
  });

  it("update creates a linked roster entry and round-trips every field (incl desiredActivity) across a re-read", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const patch = {
      lastName: "山田",
      firstName: "太郎",
      lastNameKana: "やまだ",
      firstNameKana: "たろう",
      lastNameRomaji: "Yamada",
      firstNameRomaji: "Taro",
      schoolEmail: "taro@school.ac.jp",
      gmail: "taro@gmail.com",
      phone: "090-1111-2222",
      grade: "3",
      department: "情報工学科",
      rosterNumber: "3EP2-26",
      studentNumber: "1400980",
      desiredActivity: "dev",
      note: "よろしく",
    };
    const upd = await call(app, "POST", "/members/internal/me/participation", { userId: IDU, internal: true, body: patch });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject(patch);

    // Persisted: a fresh GET (new request) reflects the same values from the real repo.
    const read = await call(app, "GET", "/members/internal/me/participation", { userId: IDU, internal: true });
    expect(read.json).toMatchObject(patch);
    expect(read.json.operations).toEqual({ name: "山田 太郎", roleTitle: null, status: "added", teams: [], leaderName: null });

    // A member_people row was created, linked to the identity user, name composed "姓 名".
    const person = await deps.repo.getPersonByIdentityUserId(deps.orgId, IDU);
    expect(person).not.toBeNull();
    expect(person!.name).toBe("山田 太郎");
    expect(person!.desiredActivity).toBe("dev");
  });

  it("a second update patches the existing linked entry (no duplicate rows)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { lastName: "佐藤", firstName: "花子", schoolEmail: "h@s.ac.jp", gmail: "h@gmail.com" },
    });
    const upd2 = await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { phone: "080-9999-0000", desiredActivity: "both" },
    });
    expect(upd2.status).toBe(200);
    expect(upd2.json.phone).toBe("080-9999-0000");
    expect(upd2.json.desiredActivity).toBe("both");
    // earlier fields survive the partial patch
    expect(upd2.json.lastName).toBe("佐藤");

    const people = await deps.repo.listPeople(deps.orgId);
    const linked = people.filter((p) => p.identityUserId === IDU);
    expect(linked).toHaveLength(1);
  });

  it("normalizes 名列番号 on self update and rejects a malformed one", async () => {
    const app = createApp(makeDeps());
    const ok = await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { lastName: "佐藤", rosterNumber: "３ｅｐ２－２６" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.rosterNumber).toBe("3EP2-26");
    const bad = await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { rosterNumber: "abc" },
    });
    expect(bad.status).toBe(400);
  });

  it("rejects an invalid grade / desiredActivity enum", async () => {
    const app = createApp(makeDeps());
    const bad = await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { grade: "99" },
    });
    expect(bad.status).toBe(400);
  });

  it("returns the roster's 運営 fields read-only and lets the caller edit only 連絡先", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const admin = { userId: "admin" };
    const team = await call(app, "POST", "/members/teams", { ...admin, body: { name: "開発チーム" } });
    const leader = await call(app, "POST", "/members/people", {
      ...admin,
      body: { lastName: "荒木", firstName: "大地", status: "added", teamIds: [] },
    });
    const me = await call(app, "POST", "/members/people", {
      ...admin,
      body: {
        lastName: "高岡",
        roleTitle: "副代表",
        status: "added",
        teamIds: [team.json.id],
        leaderId: leader.json.id,
        contact: "old@example.com",
      },
    });
    await call(app, "PATCH", `/members/people/${me.json.id}`, {
      ...admin,
      body: { identityUserId: IDU, version: me.json.version },
    });

    const read = await call(app, "GET", "/members/internal/me/participation", { userId: IDU, internal: true });
    expect(read.status).toBe(200);
    expect(read.json.contact).toBe("old@example.com");
    expect(read.json.operations).toEqual({
      name: "高岡",
      roleTitle: "副代表",
      status: "added",
      teams: [{ id: team.json.id, name: "開発チーム", color: team.json.color }],
      leaderName: "荒木 大地",
    });

    // 本人が運営の項目を送っても変わらない (連絡先だけ反映)。
    const upd = await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { contact: " new@example.com ", roleTitle: "代表", status: "declined", teamIds: [], leaderId: null },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.contact).toBe("new@example.com");
    expect(upd.json.operations.roleTitle).toBe("副代表");
    expect(upd.json.operations.status).toBe("added");
    expect(upd.json.operations.teams).toHaveLength(1);
    expect(upd.json.operations.leaderName).toBe("荒木 大地");

    const person = await deps.repo.getPersonByIdentityUserId(deps.orgId, IDU);
    expect(person!.contact).toBe("new@example.com");
    expect(person!.roleTitle).toBe("副代表");
    expect(person!.leaderId).toBe(leader.json.id);
  });
});
