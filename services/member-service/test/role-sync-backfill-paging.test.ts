// 一括付与 (backfill) のページ分け。Workers 無料枠の subrequest 上限 (50/呼び出し) に収まるよう、
// 1 ページで identity に出す呼び出し数が予算内であること・全ページで全員がちょうど 1 回ずつ
// 扱われること・ロール一覧の同期が先頭ページだけであること・activateOnly を守る。
import { describe, it, expect } from "vitest";
import { member, type identity } from "@dub/types";
import { createApp } from "../src/app";
import type { RoleSyncPort } from "../src/roleSync";
import type { IdentityActivationPort } from "../src/identityActivation";
import { adminGrants, call, fakeAuthz, makeDeps } from "./harness";

type App = ReturnType<typeof createApp>;

/** identity への呼び出しを数える fake (役職ロール付与 + 有効化)。 */
class CountingIdentity implements RoleSyncPort, IdentityActivationPort {
  calls = 0;
  catalogCalls = 0;
  synced: string[] = [];
  activatedIds: string[] = [];
  status = new Map<string, identity.UserStatus>();
  async syncCatalog(): Promise<identity.PutManagedRoleCatalogResponse> {
    this.calls++;
    this.catalogCalls++;
    return { dryRun: false, created: [], renamed: [], deleted: [], kept: [] };
  }
  async syncUser(_c: unknown, uid: string, req: identity.PutUserManagedRolesRequest): Promise<identity.PutUserManagedRolesResponse> {
    this.calls++;
    this.synced.push(uid);
    return { dryRun: !!req.dryRun, added: [], removed: [], manual: [] };
  }
  async activate(_c: unknown, uid: string, req: identity.ActivateInvitedUserRequest): Promise<identity.ActivateInvitedUserResponse> {
    this.calls++;
    this.activatedIds.push(uid);
    const prev = this.status.get(uid) ?? "active";
    const dryRun = !!req.dryRun;
    if (prev !== "invited") return { dryRun, activated: false, previousStatus: prev, status: prev };
    if (!dryRun) this.status.set(uid, "active");
    return { dryRun, activated: true, previousStatus: prev, status: dryRun ? prev : "active" };
  }
  reset(): void {
    this.calls = 0;
    this.catalogCalls = 0;
    this.synced = [];
    this.activatedIds = [];
  }
}

/** Workers 無料枠 50 から認可チェック (1) を引いた、member-service が 1 呼び出しで使える上限。 */
const SUBREQUEST_LIMIT = 50 - 1;

async function seed(n: number, opts: { invitedEvery?: number; notAddedEvery?: number } = {}) {
  const idp = new CountingIdentity();
  const authz = fakeAuthz(new Set([...adminGrants(), "app:admin:view", "app:admin:edit"] as identity.PermissionKey[]));
  const app = createApp(makeDeps({ roleSync: idp, identityActivation: idp, authz }));
  for (let i = 0; i < n; i++) {
    const status = opts.notAddedEvery && i % opts.notAddedEvery === 0 ? "invited" : "added";
    const m = await call(app, "POST", "/members/people", { body: { name: `p${i}`, status, teamIds: [] } });
    await call(app, "POST", `/members/people/${m.json.id}/identity-link`, { body: { identityUserId: `usr_${i}`, version: m.json.version } });
    if (opts.invitedEvery && i % opts.invitedEvery === 0) idp.status.set(`usr_${i}`, "invited");
  }
  await call(app, "POST", "/members/people", { body: { name: "未リンク", status: "added", teamIds: [] } });
  idp.reset();
  return { app, idp };
}

async function runAll(app: App, idp: CountingIdentity, body: Record<string, unknown>) {
  const pages: Array<Record<string, any>> = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const before = idp.calls;
    const res = await call(app, "POST", "/members/role-sync/backfill", { body: { ...body, offset } });
    expect(res.status).toBe(200);
    expect(idp.calls - before).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(idp.calls - before).toBeLessThanOrEqual(member.ROLE_SYNC_BACKFILL_CALL_BUDGET + 1);
    pages.push({ ...res.json, calls: idp.calls - before });
    offset = res.json.nextOffset;
    expect(pages.length).toBeLessThan(50);
  }
  return pages;
}

describe("POST /members/role-sync/backfill — ページ分け", () => {
  it("既定 limit で全員がちょうど 1 回ずつ・ロール一覧は先頭ページだけ・各ページ予算内", async () => {
    const { app, idp } = await seed(60, { invitedEvery: 5 });
    const pages = await runAll(app, idp, { dryRun: true });
    expect(pages.length).toBe(4); // 60 / 15
    const ids = pages.flatMap((p) => p.people.map((x: { identityUserId: string }) => x.identityUserId));
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(idp.catalogCalls).toBe(1);
    expect(pages.map((p) => p.offset)).toEqual([0, 15, 30, 45]);
    expect(pages.every((p) => p.total === 60 && p.limit === 15)).toBe(true);
    expect(pages.at(-1)!.nextOffset).toBeNull();
    expect(Math.max(...pages.map((p) => p.calls))).toBe(31); // 1 + 15 * 2
    expect(pages.reduce((a, p) => a + p.activated, 0)).toBe(12);
  });

  it("limit 指定・上限超過と不正値は 400", async () => {
    const { app, idp } = await seed(7);
    const pages = await runAll(app, idp, { dryRun: true, limit: 3 });
    expect(pages.map((p) => p.people.length)).toEqual([3, 3, 1]);
    expect(idp.catalogCalls).toBe(1);
    for (const bad of [{ limit: 16 }, { limit: 0 }, { offset: -1 }, { limit: 1.5 }, { offset: "1" }]) {
      expect((await call(app, "POST", "/members/role-sync/backfill", { body: bad })).status).toBe(400);
    }
    expect((await call(app, "POST", "/members/role-sync/backfill", { body: { activateOnly: true, limit: 30 } })).status).toBe(200);
    expect((await call(app, "POST", "/members/role-sync/backfill", { body: { activateOnly: true, limit: 31 } })).status).toBe(400);
  });

  it("activateOnly: 付与せず、在籍で紐付いた人だけ有効化 (dryRun は書かない)", async () => {
    const { app, idp } = await seed(70, { invitedEvery: 6, notAddedEvery: 7 });
    const eligible = 70 - 10; // i % 7 === 0 は名簿で招待中 = 対象外
    const dry = await runAll(app, idp, { dryRun: true, activateOnly: true });
    expect(dry.length).toBe(2); // 60 / 30
    expect(idp.synced).toHaveLength(0);
    expect(idp.catalogCalls).toBe(0);
    expect(dry.every((p) => p.activateOnly === true && p.total === eligible)).toBe(true);
    expect(dry.every((p) => p.calls <= 30)).toBe(true);
    const ids = dry.flatMap((p) => p.people.map((x: { identityUserId: string }) => x.identityUserId));
    expect(new Set(ids).size).toBe(eligible);
    const expected = [...idp.status].filter(([uid, s]) => s === "invited" && Number(uid.slice(4)) % 7 !== 0).length;
    expect(dry.reduce((a, p) => a + p.activated, 0)).toBe(expected);
    expect([...idp.status.values()].filter((s) => s === "invited")).toHaveLength(12);

    idp.reset();
    const real = await runAll(app, idp, { activateOnly: true });
    expect(real.reduce((a, p) => a + p.activated, 0)).toBe(expected);
    expect(idp.status.get("usr_0")).toBe("invited"); // 名簿で招待中の人は触らない
    expect(idp.status.get("usr_6")).toBe("active");
  });

  it("activateOnly は roleSync 未結線でも動き、有効化が未結線なら 502", async () => {
    const authz = fakeAuthz(new Set([...adminGrants(), "app:admin:view", "app:admin:edit"] as identity.PermissionKey[]));
    const idp = new CountingIdentity();
    const onlyAct = createApp(makeDeps({ identityActivation: idp, authz }));
    expect((await call(onlyAct, "POST", "/members/role-sync/backfill", { body: { activateOnly: true } })).status).toBe(200);
    const onlySync = createApp(makeDeps({ roleSync: idp, authz }));
    expect((await call(onlySync, "POST", "/members/role-sync/backfill", { body: { activateOnly: true } })).status).toBe(502);
  });
});
