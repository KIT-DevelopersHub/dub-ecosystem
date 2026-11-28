// #942 自分がマネジメントする範囲: リーダー → 自分の班のメンバー / オーガナイザー → 自分のチームの
// リーダーとメンバー。それより広くは返さない (他の班・他のチーム・一般メンバーは空)。
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, call } from "./harness";

type App = ReturnType<typeof createApp>;

async function team(app: App, name: string): Promise<string> {
  const t = await call(app, "POST", "/members/teams", { body: { name } });
  return t.json.id as string;
}

async function person(
  app: App,
  name: string,
  uid: string | null,
  o: { teamIds: string[]; position?: "organizer" | "leader" | "member"; leaderId?: string; roleTitle?: string; status?: string },
): Promise<string> {
  const m = await call(app, "POST", "/members/people", {
    body: { name, status: o.status ?? "added", teamIds: o.teamIds, ...(o.position ? { position: o.position } : {}), ...(o.leaderId ? { leaderId: o.leaderId } : {}), ...(o.roleTitle ? { roleTitle: o.roleTitle } : {}) },
  });
  if (uid) await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId: uid, version: m.json.version } });
  return m.json.id as string;
}

// 広報チーム: org1 (オーガナイザー) / 班A = leadA + a1, a2 / 班B = leadB + b1
// 会場チーム: org2 / leadC + c1
async function seed(app: App) {
  const pr = await team(app, "広報");
  const venue = await team(app, "会場");
  await person(app, "org1", "usr_org1", { teamIds: [pr], position: "organizer" });
  await person(app, "orgPeer", "usr_orgpeer", { teamIds: [pr], position: "organizer" });
  const leadA = await person(app, "leadA", "usr_leadA", { teamIds: [pr], position: "leader" });
  const leadB = await person(app, "leadB", "usr_leadB", { teamIds: [pr], position: "leader" });
  const a1 = await person(app, "a1", "usr_a1", { teamIds: [pr], position: "member", leaderId: leadA });
  await person(app, "a2", "usr_a2", { teamIds: [pr], leaderId: a1 }); // 孫: a1 を経て leadA の班
  await person(app, "aLeft", "usr_aleft", { teamIds: [pr], leaderId: leadA, status: "declined" });
  await person(app, "aNoAccount", null, { teamIds: [pr], leaderId: leadA });
  await person(app, "b1", "usr_b1", { teamIds: [pr], position: "member", leaderId: leadB });
  await person(app, "org2", "usr_org2", { teamIds: [venue], position: "organizer" });
  const leadC = await person(app, "leadC", "usr_leadC", { teamIds: [venue], position: "leader" });
  await person(app, "c1", "usr_c1", { teamIds: [venue], leaderId: leadC });
  // roleTitle だけリーダーの人 (position 未設定): 見る側にはなれない
  const guess = await person(app, "guessLead", "usr_guess", { teamIds: [venue], roleTitle: "会場リーダー" });
  await person(app, "g1", "usr_g1", { teamIds: [venue], leaderId: guess });
}

async function managed(app: App, uid: string): Promise<string[]> {
  const res = await call(app, "GET", `/members/internal/managed-mailboxes?userId=${uid}`, { internal: true });
  expect(res.status).toBe(200);
  return (res.json.items as Array<{ userId: string }>).map((i) => i.userId).sort();
}

describe("GET /members/internal/managed-mailboxes", () => {
  it("リーダーは自分の班のメンバーだけ (他の班・辞退・未リンクは含まない)", async () => {
    const app = createApp(makeDeps());
    await seed(app);
    expect(await managed(app, "usr_leadA")).toEqual(["usr_a1", "usr_a2"]);
    expect(await managed(app, "usr_leadB")).toEqual(["usr_b1"]);
    const res = await call(app, "GET", "/members/internal/managed-mailboxes?userId=usr_leadA", { internal: true });
    expect(res.json.items[0]).toEqual({ userId: "usr_a1", name: "a1", relation: "squad" });
  });

  it("オーガナイザーは自分のチームのリーダーとメンバーだけ (他チーム・他のオーガナイザーは含まない)", async () => {
    const app = createApp(makeDeps());
    await seed(app);
    expect(await managed(app, "usr_org1")).toEqual(["usr_a1", "usr_a2", "usr_b1", "usr_leadA", "usr_leadB"]);
    expect(await managed(app, "usr_org2")).not.toContain("usr_a1");
  });

  it("一般メンバー・役職未設定・名簿に居ない人は空", async () => {
    const app = createApp(makeDeps());
    await seed(app);
    expect(await managed(app, "usr_a1")).toEqual([]);
    expect(await managed(app, "usr_guess")).toEqual([]);
    expect(await managed(app, "usr_stranger")).toEqual([]);
    expect((await call(app, "GET", "/members/internal/managed-mailboxes", { internal: true })).json.items).toEqual([]);
  });

  it("is service-to-service only — an external caller gets 403 internal_only", async () => {
    const res = await call(createApp(makeDeps()), "GET", "/members/internal/managed-mailboxes?userId=usr_org1");
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("internal_only");
  });
});
