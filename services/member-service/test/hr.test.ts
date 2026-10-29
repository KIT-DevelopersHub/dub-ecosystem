// 人事: 応募者 CRUD + 段階遷移 + 履歴 + 参加確定 (名簿へ) + オンボーディングのチェック + 権限。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { call, createApp, fakeAuthz, makeDeps } from "./harness";

type App = ReturnType<typeof createApp>;

async function newApplicant(app: App, body: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  const res = await call(app, "POST", "/members/hr/applicants", { body: { name: "山本 花", email: "hana@example.com", ...body } });
  expect(res.status).toBe(201);
  return { id: res.json.applicant.id, version: res.json.applicant.version };
}

async function move(app: App, id: string, stage: string, expectedVersion: number) {
  return call(app, "POST", `/members/hr/applicants/${id}/stage`, { body: { stage, expectedVersion } });
}

/** applied → screening → interview → offered と進めて最新 version を返す。 */
async function toOffered(app: App, id: string, v: number): Promise<number> {
  for (const stage of ["screening", "interview", "offered"]) {
    const res = await move(app, id, stage, v);
    expect(res.status, stage).toBe(200);
    v = res.json.applicant.version;
  }
  return v;
}

describe("人事: applicants", () => {
  it("creates an applicant in 応募 with a created event and lists it", async () => {
    const app = createApp(makeDeps());
    const created = await call(app, "POST", "/members/hr/applicants", {
      body: { name: "  山本 花 ", source: "公開フォーム", motivation: "運営をやってみたい" },
    });
    expect(created.status).toBe(201);
    expect(created.json.applicant).toMatchObject({ name: "山本 花", stage: "applied", memberId: null, version: 1 });
    expect(created.json.events.map((e: { kind: string }) => e.kind)).toEqual(["created"]);

    const list = await call(app, "GET", "/members/hr/applicants");
    expect(list.status).toBe(200);
    expect(list.json.applicants).toHaveLength(1);
  });

  it("validates name and desired team", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "POST", "/members/hr/applicants", { body: { name: " " } })).status).toBe(400);
    expect((await call(app, "POST", "/members/hr/applicants", { body: { name: "x", desiredTeamId: "team_nope" } })).status).toBe(400);
  });

  it("updates profile fields with optimistic locking (409 on stale version)", async () => {
    const app = createApp(makeDeps());
    const a = await newApplicant(app);
    const ok = await call(app, "PATCH", `/members/hr/applicants/${a.id}`, { body: { department: "情報工学科", expectedVersion: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ department: "情報工学科", version: 2 });
    const stale = await call(app, "PATCH", `/members/hr/applicants/${a.id}`, { body: { department: "x", expectedVersion: 1 } });
    expect(stale.status).toBe(409);
  });

  it("moves through allowed stages and records history; rejects illegal transitions", async () => {
    const app = createApp(makeDeps());
    const a = await newApplicant(app);
    // 応募 → 内定 の飛び級は不可。
    expect((await move(app, a.id, "offered", 1)).status).toBe(409);
    // joined へは /stage では進めない。
    expect((await move(app, a.id, "joined", 1)).status).toBe(409);
    expect((await move(app, a.id, "bogus", 1)).status).toBe(400);

    const v = await toOffered(app, a.id, 1);
    const detail = await call(app, "GET", `/members/hr/applicants/${a.id}`);
    expect(detail.json.applicant).toMatchObject({ stage: "offered", version: v });
    expect(detail.json.events.map((e: { toStage: string | null }) => e.toStage)).toEqual(["applied", "screening", "interview", "offered"]);
  });

  it("rejected / withdrawn can be reopened to 応募", async () => {
    const app = createApp(makeDeps());
    const a = await newApplicant(app);
    const r = await move(app, a.id, "rejected", 1);
    expect(r.status).toBe(200);
    expect((await move(app, a.id, "screening", 2)).status).toBe(409);
    expect((await move(app, a.id, "applied", 2)).status).toBe(200);
  });

  it("adds notes to the history", async () => {
    const app = createApp(makeDeps());
    const a = await newApplicant(app);
    const res = await call(app, "POST", `/members/hr/applicants/${a.id}/notes`, { body: { body: "面談: 意欲高い" } });
    expect(res.status).toBe(201);
    expect(res.json.events.at(-1)).toMatchObject({ kind: "note", body: "面談: 意欲高い", actorId: "user_caller" });
    expect((await call(app, "POST", `/members/hr/applicants/${a.id}/notes`, { body: { body: "" } })).status).toBe(400);
  });

  it("deletes (archives) an applicant", async () => {
    const app = createApp(makeDeps());
    const a = await newApplicant(app);
    expect((await call(app, "DELETE", `/members/hr/applicants/${a.id}`)).status).toBe(200);
    expect((await call(app, "GET", `/members/hr/applicants/${a.id}`)).status).toBe(404);
    expect((await call(app, "GET", "/members/hr/applicants")).json.applicants).toHaveLength(0);
  });
});

describe("人事: 参加確定 → 名簿", () => {
  it("join is only possible from 内定", async () => {
    const app = createApp(makeDeps());
    const a = await newApplicant(app);
    expect((await call(app, "POST", `/members/hr/applicants/${a.id}/join`, { body: { expectedVersion: 1 } })).status).toBe(409);
  });

  it("creates a new 在籍 roster row from the applicant (no duplicate registry)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const team = await call(app, "POST", "/members/teams", { body: { name: "開発チーム" } });
    const a = await newApplicant(app, { desiredTeamId: team.json.id, department: "情報工学科", grade: "2年" });
    const v = await toOffered(app, a.id, a.version);

    const joined = await call(app, "POST", `/members/hr/applicants/${a.id}/join`, { body: { expectedVersion: v } });
    expect(joined.status).toBe(200);
    expect(joined.json.applicant).toMatchObject({ stage: "joined" });
    const memberId = joined.json.memberId as string;

    const overview = await call(app, "GET", "/members/overview");
    const m = overview.json.members.find((x: { id: string }) => x.id === memberId);
    expect(m).toMatchObject({ name: "山本 花", status: "added", teamIds: [team.json.id], department: "情報工学科", contact: "hana@example.com" });

    // joined からは /stage で動かせない。
    expect((await move(app, a.id, "offered", v + 1)).status).toBe(409);
  });

  it("links to an existing invited roster row and promotes it to 在籍", async () => {
    const app = createApp(makeDeps());
    const existing = await call(app, "POST", "/members/people", { body: { name: "山本 花", status: "invited", teamIds: [] } });
    const a = await newApplicant(app);
    const v = await toOffered(app, a.id, a.version);
    const joined = await call(app, "POST", `/members/hr/applicants/${a.id}/join`, {
      body: { expectedVersion: v, memberId: existing.json.id },
    });
    expect(joined.status).toBe(200);
    expect(joined.json.memberId).toBe(existing.json.id);
    const overview = await call(app, "GET", "/members/overview");
    expect(overview.json.members).toHaveLength(1);
    expect(overview.json.members[0]).toMatchObject({ id: existing.json.id, status: "added" });
  });
});

describe("人事: オンボーディング", () => {
  it("uses the 参加届 onboarding items as the checklist and tracks per-member progress", async () => {
    const app = createApp(makeDeps());
    const i1 = await call(app, "POST", "/members/onboarding", { body: { title: "Slack に参加" } });
    const i2 = await call(app, "POST", "/members/onboarding", { body: { title: "アイコン設定" } });
    const a = await newApplicant(app);
    const v = await toOffered(app, a.id, a.version);
    const { json } = await call(app, "POST", `/members/hr/applicants/${a.id}/join`, { body: { expectedVersion: v } });
    const memberId = json.memberId as string;

    let ob = await call(app, "GET", "/members/hr/onboarding");
    expect(ob.status).toBe(200);
    expect(ob.json.items.map((i: { title: string }) => i.title)).toEqual(["Slack に参加", "アイコン設定"]);
    expect(ob.json.members).toEqual([
      expect.objectContaining({ memberId, applicantId: a.id, done: 0, total: 2, completed: false }),
    ]);

    const put = (itemId: string, checked: boolean) =>
      call(app, "PUT", `/members/hr/onboarding/${memberId}/items/${itemId}`, { body: { checked } });
    expect((await put(i1.json.id, true)).json).toMatchObject({ done: 1, completed: false });
    expect((await put(i2.json.id, true)).json).toMatchObject({ done: 2, completed: true });
    expect((await put(i2.json.id, false)).json).toMatchObject({ done: 1, completed: false });

    ob = await call(app, "GET", "/members/hr/onboarding");
    expect(ob.json.members[0].checkedItemIds).toEqual([i1.json.id]);
    expect((await put("onb_missing", true)).status).toBe(404);
  });
});

describe("人事: permissions (policy table end to end)", () => {
  const keys = (...k: identity.PermissionKey[]) => new Set<identity.PermissionKey>(k);

  it("viewer (閲覧 + hr:read) can read but not write", async () => {
    const deps = makeDeps();
    const admin = createApp(deps);
    const a = await newApplicant(admin);
    const viewer = createApp({ ...deps, authz: fakeAuthz(keys("app:hr:view", "hr:read")) });
    expect((await call(viewer, "GET", "/members/hr/applicants")).status).toBe(200);
    expect((await call(viewer, "GET", `/members/hr/applicants/${a.id}`)).status).toBe(200);
    expect((await call(viewer, "POST", "/members/hr/applicants", { body: { name: "x" } })).status).toBe(403);
    expect((await move(viewer, a.id, "screening", 1)).status).toBe(403);
  });

  it("recruiter (編集 + hr:write) can move stages but cannot confirm joins", async () => {
    const deps = makeDeps();
    const admin = createApp(deps);
    const a = await newApplicant(admin);
    const v = await toOffered(admin, a.id, a.version);
    const recruiter = createApp({ ...deps, authz: fakeAuthz(keys("app:hr:view", "app:hr:edit", "hr:read", "hr:write")) });
    expect((await call(recruiter, "POST", `/members/hr/applicants/${a.id}/notes`, { body: { body: "ok" } })).status).toBe(201);
    expect((await call(recruiter, "POST", `/members/hr/applicants/${a.id}/join`, { body: { expectedVersion: v } })).status).toBe(403);
    expect((await call(recruiter, "DELETE", `/members/hr/applicants/${a.id}`)).status).toBe(403);
  });

  it("app disabled (no app:hr:view) denies even with hr:* keys; roster roles see nothing", async () => {
    const deps = makeDeps();
    const noApp = createApp({ ...deps, authz: fakeAuthz(keys("hr:read", "hr:write", "hr:admin")) });
    expect((await call(noApp, "GET", "/members/hr/applicants")).status).toBe(403);
    const rosterOnly = createApp({ ...deps, authz: fakeAuthz(keys("identity:read", "app:members:view", "app:members:edit")) });
    expect((await call(rosterOnly, "GET", "/members/hr/onboarding")).status).toBe(403);
  });
});
