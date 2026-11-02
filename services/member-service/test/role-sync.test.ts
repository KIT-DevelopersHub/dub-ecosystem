// 役職 (position) と、名簿のチーム・役職から付く自動ロールの同期 (roleSync)。
// identity-roster 側の差分適用は identity-roster/test/managed-roles.test.ts が守る。ここは
// 「誰に・どのロール集合を・いつ送るか」と、同期失敗でも名簿の保存が成功することを守る。
import { describe, it, expect } from "vitest";
import { member, type identity } from "@dub/types";
import { createApp } from "../src/app";
import type { RoleSyncCtx, RoleSyncPort } from "../src/roleSync";
import { adminGrants, call, fakeAuthz, makeDeps } from "./harness";

const EMAILS = { schoolEmail: "taro@school.ac.jp", gmail: "taro@gmail.com" };

class FakeRoleSync implements RoleSyncPort {
  /** identity userId -> 最後に送られたロール id 集合。 */
  users = new Map<string, string[]>();
  catalogs: identity.ManagedRoleSpec[][] = [];
  fail = false;
  async syncCatalog(_ctx: RoleSyncCtx, req: identity.PutManagedRoleCatalogRequest): Promise<identity.PutManagedRoleCatalogResponse> {
    if (this.fail) throw new Error("identity down");
    if (!req.dryRun) this.catalogs.push(req.roles);
    return { dryRun: !!req.dryRun, created: [], renamed: [], deleted: [], kept: [] };
  }
  async syncUser(ctx: RoleSyncCtx, uid: string, req: identity.PutUserManagedRolesRequest): Promise<identity.PutUserManagedRolesResponse> {
    if (this.fail) throw new Error("identity down");
    const before = this.users.get(uid) ?? [];
    const after = req.roles.map((r) => r.id);
    if (!req.dryRun) this.users.set(uid, after);
    this.lastActor = ctx.userId;
    return { dryRun: !!req.dryRun, added: after.filter((r) => !before.includes(r)), removed: before.filter((r) => !after.includes(r)), manual: [] };
  }
  lastActor = "";
}

function setup() {
  const sync = new FakeRoleSync();
  const app = createApp(makeDeps({ roleSync: sync }));
  return { app, sync };
}
async function team(app: ReturnType<typeof createApp>, name: string): Promise<string> {
  return (await call(app, "POST", "/members/teams", { body: { name } })).json.id as string;
}
async function linkedPerson(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
  identityUserId: string,
): Promise<{ id: string; version: number }> {
  const m = await call(app, "POST", "/members/people", { body: { name: "高岡", status: "added", teamIds: [], ...body } });
  const l = await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId, version: m.json.version } });
  return { id: l.json.id, version: l.json.version };
}

describe("position (役職)", () => {
  it("参加届で受け取り、不正値は 400、create で名簿に引き継ぐ", async () => {
    const { app } = setup();
    const bad = await call(app, "POST", "/members/participation", { body: { lastName: "山田", firstName: "太郎", position: "boss", ...EMAILS } });
    expect(bad.status).toBe(400);
    const sub = await call(app, "POST", "/members/participation", { body: { lastName: "山田", firstName: "太郎", position: "leader", ...EMAILS } });
    expect(sub.status).toBe(201);
    expect(sub.json.participation.position).toBe("leader");
    const res = await call(app, "POST", `/members/participation/${sub.json.participation.id}/resolve`, { body: { action: "create" } });
    expect(res.json.member.position).toBe("leader");
  });

  it("link (昇格) は名簿が未設定のときだけ参加届の役職を入れる (管理者の訂正は上書きしない)", async () => {
    const { app } = setup();
    const empty = await call(app, "POST", "/members/people", { body: { name: "山田 太郎", status: "invited", teamIds: [] } });
    const set = await call(app, "POST", "/members/people", { body: { name: "佐藤 花子", status: "invited", teamIds: [], position: "member" } });
    const s1 = await call(app, "POST", "/members/participation", { body: { lastName: "山田", firstName: "太郎", position: "leader", ...EMAILS } });
    const s2 = await call(app, "POST", "/members/participation", {
      body: { lastName: "佐藤", firstName: "花子", position: "organizer", schoolEmail: "h@school.ac.jp", gmail: "h@gmail.com" },
    });
    const r1 = await call(app, "POST", `/members/participation/${s1.json.participation.id}/resolve`, {
      body: { action: "link", memberId: empty.json.id, expectedVersion: empty.json.version },
    });
    const r2 = await call(app, "POST", `/members/participation/${s2.json.participation.id}/resolve`, {
      body: { action: "link", memberId: set.json.id, expectedVersion: set.json.version },
    });
    expect(r1.json.member.position).toBe("leader");
    expect(r2.json.member.position).toBe("member");
  });

  it("名簿で管理者が設定・解除できる (null で解除、不正値は 400)", async () => {
    const { app } = setup();
    const m = await call(app, "POST", "/members/people", { body: { name: "高岡", status: "added", teamIds: [], position: "organizer" } });
    expect(m.json.position).toBe("organizer");
    const bad = await call(app, "PATCH", `/members/people/${m.json.id}`, { body: { position: "boss", version: m.json.version } });
    expect(bad.status).toBe(400);
    const cleared = await call(app, "PATCH", `/members/people/${m.json.id}`, { body: { position: null, version: m.json.version } });
    expect(cleared.json.position).toBeNull();
  });
});

describe("role sync (名簿 -> 自動ロール)", () => {
  it("紐付け時にチーム全部 + 役職 1 つを送る (granted_by = 操作した管理者)", async () => {
    const { app, sync } = setup();
    const pr = await team(app, "広報");
    const dev = await team(app, "開発");
    await linkedPerson(app, { teamIds: [pr, dev], position: "leader" }, "usr_a");
    expect(sync.users.get("usr_a")).toEqual([member.positionRoleId("leader"), member.teamRoleId(pr), member.teamRoleId(dev)]);
    expect(sync.lastActor).toBe("user_caller");
  });

  it("チーム・役職の変更で送り直し、在籍中以外・アーカイブ・紐付け解除は空集合", async () => {
    const { app, sync } = setup();
    const pr = await team(app, "広報");
    const dev = await team(app, "開発");
    let p = await linkedPerson(app, { teamIds: [pr], position: "member" }, "usr_a");

    let r = await call(app, "PATCH", `/members/people/${p.id}`, { body: { teamIds: [dev], position: "organizer", version: p.version } });
    expect(sync.users.get("usr_a")).toEqual([member.positionRoleId("organizer"), member.teamRoleId(dev)]);
    p = { id: p.id, version: r.json.version };

    r = await call(app, "PATCH", `/members/people/${p.id}`, { body: { status: "on_leave", version: p.version } });
    expect(sync.users.get("usr_a")).toEqual([]);
    p = { id: p.id, version: r.json.version };

    r = await call(app, "PATCH", `/members/people/${p.id}`, { body: { status: "added", identityUserId: "usr_b", version: p.version } });
    expect(sync.users.get("usr_a")).toEqual([]); // 旧アカウントは外す
    expect(sync.users.get("usr_b")).toEqual([member.positionRoleId("organizer"), member.teamRoleId(dev)]);

    await call(app, "DELETE", `/members/people/${p.id}`);
    expect(sync.users.get("usr_b")).toEqual([]);
  });

  it("役職が未設定なら役職ロールは付けない (role_title からは推測しない)", async () => {
    const { app, sync } = setup();
    const pr = await team(app, "広報");
    await linkedPerson(app, { teamIds: [pr], roleTitle: "広報リーダー" }, "usr_a");
    expect(sync.users.get("usr_a")).toEqual([member.teamRoleId(pr)]);
  });

  it("チームの作成・改名・削除でロール一覧 (役職 3 + チーム) を送る", async () => {
    const { app, sync } = setup();
    const pr = await team(app, "広報");
    expect(sync.catalogs.at(-1)).toEqual([
      ...member.MEMBER_POSITIONS.map((p) => ({ id: member.positionRoleId(p), name: member.positionRoleName(p) })),
      { id: member.teamRoleId(pr), name: "チーム: 広報" },
    ]);
    const n = sync.catalogs.length;
    await call(app, "PATCH", `/members/teams/${pr}`, { body: { color: "#ff0000" } });
    expect(sync.catalogs.length).toBe(n); // 名前が変わらなければ送らない
    await call(app, "PATCH", `/members/teams/${pr}`, { body: { name: "広報部" } });
    expect(sync.catalogs.at(-1)?.at(-1)).toEqual({ id: member.teamRoleId(pr), name: "チーム: 広報部" });
    await call(app, "DELETE", `/members/teams/${pr}`);
    expect(sync.catalogs.at(-1)?.map((r) => r.id)).not.toContain(member.teamRoleId(pr));
  });

  it("identity が落ちていても名簿の保存は成功する (best-effort)", async () => {
    const { app, sync } = setup();
    sync.fail = true;
    const pr = await call(app, "POST", "/members/teams", { body: { name: "広報" } });
    expect(pr.status).toBe(201);
    const m = await call(app, "POST", "/members/people", { body: { name: "高岡", status: "added", teamIds: [pr.json.id] } });
    const l = await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId: "usr_a", version: m.json.version } });
    expect(l.status).toBe(200);
  });
});

describe("POST /members/role-sync/backfill", () => {
  const backfillGrants = () => fakeAuthz(new Set([...adminGrants(), "app:admin:view", "app:admin:edit"] as identity.PermissionKey[]));

  it("dryRun は書かずに、紐付いた全員の予定を返す", async () => {
    const sync = new FakeRoleSync();
    const app = createApp(makeDeps({ roleSync: sync, authz: backfillGrants() }));
    const pr = await team(app, "広報");
    await linkedPerson(app, { teamIds: [pr], position: "member" }, "usr_a");
    await call(app, "POST", "/members/people", { body: { name: "未リンク", status: "added", teamIds: [pr] } });
    sync.users.clear();

    const dry = await call(app, "POST", "/members/role-sync/backfill", { body: { dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.people).toHaveLength(1);
    expect(dry.json.people[0]).toMatchObject({ identityUserId: "usr_a", added: [member.positionRoleId("member"), member.teamRoleId(pr)] });
    expect(sync.users.size).toBe(0);

    const real = await call(app, "POST", "/members/role-sync/backfill", { body: {} });
    expect(real.json).toMatchObject({ dryRun: false, failed: 0 });
    expect(sync.users.get("usr_a")).toEqual([member.positionRoleId("member"), member.teamRoleId(pr)]);
  });

  it("名簿編集者 (identity:admin なし) は 403、roleSync 未結線は 502", async () => {
    const forbidden = createApp(makeDeps({ roleSync: new FakeRoleSync() }));
    expect((await call(forbidden, "POST", "/members/role-sync/backfill", { body: {} })).status).toBe(403);
    const unwired = createApp(makeDeps({ authz: backfillGrants() }));
    expect((await call(unwired, "POST", "/members/role-sync/backfill", { body: {} })).status).toBe(502);
  });
});
