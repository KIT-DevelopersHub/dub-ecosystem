// Self 参加届 (アカウント設定 → 参加情報): the signed-in user reads/edits their OWN 参加届,
// resolved via the identity link to their member_people row. Reached through the gateway
// at GET/POST /api/v1/me/participation, forwarded here as an internal s2s call
// (x-dub-internal + the caller's identity x-dub-user-id). Drives the real Hono app over
// the in-memory repo.
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, call } from "./harness";

const IDU = "idu_self"; // the caller's identity userId (forwarded as x-dub-user-id)

describe("member-service self 参加届 (/members/internal/me/participation)", () => {
  it("404s without x-dub-internal (route never exposed externally)", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/members/internal/me/participation", { userId: IDU });
    expect(res.status).toBe(404);
  });

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
      desiredActivity: null,
      note: null,
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
      desiredActivity: "dev",
      note: "よろしく",
    };
    const upd = await call(app, "POST", "/members/internal/me/participation", { userId: IDU, internal: true, body: patch });
    expect(upd.status).toBe(200);
    expect(upd.json).toEqual(patch);

    // Persisted: a fresh GET (new request) reflects the same values from the real repo.
    const read = await call(app, "GET", "/members/internal/me/participation", { userId: IDU, internal: true });
    expect(read.json).toEqual(patch);

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

  it("rejects an invalid grade / desiredActivity enum", async () => {
    const app = createApp(makeDeps());
    const bad = await call(app, "POST", "/members/internal/me/participation", {
      userId: IDU,
      internal: true,
      body: { grade: "99" },
    });
    expect(bad.status).toBe(400);
  });
});
