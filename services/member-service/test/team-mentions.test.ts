// チーム単位メンション (<!team:id>) の展開 API。chat-service が投稿時に s2s で呼び、
// 「そのチームの、identity アカウントにリンク済みのメンバー」を通知先として受け取る。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { createApp, makeDeps, call, fakeAuthz } from "./harness";

async function seedTeamWithPeople(app: ReturnType<typeof createApp>) {
  const hq = await call(app, "POST", "/members/teams", { body: { name: "統括チーム" } });
  const corp = await call(app, "POST", "/members/teams", { body: { name: "法人チーム" } });
  const link = async (name: string, teamIds: string[], identityUserId: string | null) => {
    const m = await call(app, "POST", "/members/people", { body: { name, status: "added", teamIds } });
    if (identityUserId) {
      await call(app, "POST", `/members/people/${m.json.id}/identity-link`, {
        body: { identityUserId, version: m.json.version },
      });
    }
    return m.json.id as string;
  };
  await link("高岡", [hq.json.id], "usr_kota");
  await link("黒川", [hq.json.id], "usr_kurokawa");
  await link("未リンク", [hq.json.id], null); // アカウント未リンク -> 通知先にならない
  await link("金井", [corp.json.id], "usr_kanai");
  await link("兼任", [hq.json.id, corp.json.id], "usr_kanemu");
  return { hq: hq.json.id as string, corp: corp.json.id as string };
}

describe("GET /members/internal/team-members", () => {
  it("returns the identity accounts of one team (unlinked people skipped)", async () => {
    const app = createApp(makeDeps());
    const { hq } = await seedTeamWithPeople(app);
    const res = await call(app, "GET", `/members/internal/team-members?teamIds=${hq}`, { internal: true });
    expect(res.status).toBe(200);
    expect(res.json.userIds).toEqual(["usr_kota", "usr_kurokawa", "usr_kanemu"]);
  });

  it("unions several teams and de-dupes a member who belongs to both", async () => {
    const app = createApp(makeDeps());
    const { hq, corp } = await seedTeamWithPeople(app);
    const res = await call(app, "GET", `/members/internal/team-members?teamIds=${hq},${corp}`, { internal: true });
    expect(res.json.userIds).toEqual(["usr_kota", "usr_kurokawa", "usr_kanai", "usr_kanemu"]);
  });

  it("returns an empty list for an unknown or empty teamIds", async () => {
    const app = createApp(makeDeps());
    await seedTeamWithPeople(app);
    expect((await call(app, "GET", "/members/internal/team-members?teamIds=team_nope", { internal: true })).json.userIds).toEqual([]);
    expect((await call(app, "GET", "/members/internal/team-members", { internal: true })).json.userIds).toEqual([]);
  });

  it("is service-to-service only — an external caller gets 404 (route hidden)", async () => {
    const app = createApp(makeDeps());
    const { hq } = await seedTeamWithPeople(app);
    const res = await call(app, "GET", `/members/internal/team-members?teamIds=${hq}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /members/me/mention-teams (チーム名の解決 + 自分の所属)", () => {
  it("returns every team plus the caller's own teamIds", async () => {
    const app = createApp(makeDeps());
    const { hq, corp } = await seedTeamWithPeople(app);
    const res = await call(app, "GET", "/members/me/mention-teams", { userId: "usr_kanemu" });
    expect(res.status).toBe(200);
    expect(res.json.teams.map((t: { id: string }) => t.id)).toEqual([hq, corp]);
    expect(res.json.myTeamIds.sort()).toEqual([hq, corp].sort());
  });

  it("is readable WITHOUT roster permission — an ordinary chat member must still resolve team names", async () => {
    // 名簿権限ゼロ (identity:read も app:members:view も無い) の一般メンバー。
    const app = createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>()) }));
    // 権限ゼロでは seed できないので、seed だけ権限ありのアプリで行い、読み出しを権限ゼロで確認する。
    const seeder = createApp(makeDeps());
    await seedTeamWithPeople(seeder);
    expect((await call(seeder, "GET", "/members/teams", { userId: "usr_plain" })).status).toBe(200);
    const denied = await call(
      createApp(makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>()) })),
      "GET",
      "/members/teams",
      { userId: "usr_plain" },
    );
    expect(denied.status).toBe(403); // 対照: 名簿一覧は従来どおり弾かれる
    const res = await call(app, "GET", "/members/me/mention-teams", { userId: "usr_plain" });
    expect(res.status).toBe(200);
    expect(res.json.myTeamIds).toEqual([]); // 名簿に紐づかないアカウント -> 所属なし
  });

  it("requires a signed-in caller", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "GET", "/members/me/mention-teams", { userId: null })).status).toBe(401);
  });
});
