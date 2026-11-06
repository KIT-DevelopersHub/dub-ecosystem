// 在籍 (added) でアカウントに紐付いた名簿行 -> identity の招待中アカウントを有効化。
// identity 側の invited 限定・CAS・監査は identity-roster/test/activate-invited.test.ts と
// tests/integration/invited-activation.test.ts (password login まで) が守る。ここは
// 「どの経路で・誰について・いつ呼ぶか」と、失敗しても名簿の保存が成功することを守る。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { createApp } from "../src/app";
import type { ActivationCtx, IdentityActivationPort } from "../src/identityActivation";
import { adminGrants, call, fakeAuthz, makeDeps } from "./harness";

const EMAILS = { schoolEmail: "taro@school.ac.jp", gmail: "taro@gmail.com" };

/** identity の状態を真似る fake: invited だけ active にする。 */
class FakeIdentity implements IdentityActivationPort {
  status = new Map<string, identity.UserStatus>();
  calls: Array<{ uid: string; trigger: string; dryRun: boolean; actor: string }> = [];
  fail = false;
  async activate(ctx: ActivationCtx, uid: string, req: identity.ActivateInvitedUserRequest): Promise<identity.ActivateInvitedUserResponse> {
    this.calls.push({ uid, trigger: req.trigger, dryRun: !!req.dryRun, actor: ctx.userId });
    if (this.fail) throw new Error("identity down");
    const prev = this.status.get(uid);
    if (!prev) throw new Error("not found");
    const dryRun = !!req.dryRun;
    if (prev !== "invited") return { dryRun, activated: false, previousStatus: prev, status: prev };
    if (!dryRun) this.status.set(uid, "active");
    return { dryRun, activated: true, previousStatus: prev, status: dryRun ? prev : "active" };
  }
}

function setup() {
  const idp = new FakeIdentity();
  const app = createApp(makeDeps({ identityActivation: idp }));
  return { app, idp };
}

type App = ReturnType<typeof createApp>;

async function person(app: App, status: string): Promise<{ id: string; version: number }> {
  const m = await call(app, "POST", "/members/people", { body: { name: "山田 太郎", status, teamIds: [] } });
  expect(m.status).toBe(201);
  return { id: m.json.id, version: m.json.version };
}
async function link(app: App, p: { id: string; version: number }, identityUserId: string) {
  return call(app, "POST", `/members/people/${p.id}/identity-link`, { body: { identityUserId, version: p.version } });
}
async function submit(app: App) {
  const s = await call(app, "POST", "/members/participation", { body: { lastName: "山田", firstName: "太郎", ...EMAILS } });
  expect(s.status).toBe(201);
  return s.json.participation.id as string;
}

describe("identity activation on 在籍 + 紐付け", () => {
  it("メール発行の流れ: 参加届 create (未紐付け=何もしない) -> 紐付けで招待中アカウントを有効化", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_new", "invited");
    const pid = await submit(app);
    const created = await call(app, "POST", `/members/participation/${pid}/resolve`, { body: { action: "create" } });
    expect(created.json.member.status).toBe("added");
    expect(idp.calls).toEqual([]); // unlinked = no-op

    const l = await link(app, { id: created.json.member.id, version: created.json.member.version }, "usr_new");
    expect(l.status).toBe(200);
    expect(idp.calls).toEqual([{ uid: "usr_new", trigger: "member.link", dryRun: false, actor: "user_caller" }]);
    expect(idp.status.get("usr_new")).toBe("active");
  });

  it("参加届 link: 紐付け済みの招待中メンバーを在籍に上げた時に有効化", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_inv", "invited");
    const p = await person(app, "invited");
    const linked = await link(app, p, "usr_inv");
    expect(idp.calls).toEqual([]); // 名簿がまだ招待中なのでアカウントも招待中のまま
    const pid = await submit(app);
    const res = await call(app, "POST", `/members/participation/${pid}/resolve`, {
      body: { action: "link", memberId: p.id, expectedVersion: linked.json.version },
    });
    expect(res.json.member.status).toBe("added");
    expect(idp.calls.map((c) => c.trigger)).toEqual(["participation.link"]);
    expect(idp.status.get("usr_inv")).toBe("active");
  });

  it("採用 (人事 join): 紐付け済みの招待中名簿行を在籍に上げた時に有効化", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_hr", "invited");
    const p = await person(app, "invited");
    await link(app, p, "usr_hr");
    const a = await call(app, "POST", "/members/hr/applicants", { body: { name: "山田 太郎", email: "t@example.com" } });
    let v = a.json.applicant.version as number;
    for (const stage of ["interview_set", "interviewed"]) {
      v = (await call(app, "POST", `/members/hr/applicants/${a.json.applicant.id}/stage`, { body: { stage, expectedVersion: v } })).json.applicant.version;
    }
    const j = await call(app, "POST", `/members/hr/applicants/${a.json.applicant.id}/join`, { body: { expectedVersion: v, memberId: p.id } });
    expect(j.status).toBe(200);
    expect(idp.calls.map((c) => c.trigger)).toEqual(["hr.join"]);
    expect(idp.status.get("usr_hr")).toBe("active");
  });

  it("名簿編集で在籍に変えた時も有効化 (member.update)", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_u", "invited");
    const p = await person(app, "considering");
    const l = await link(app, p, "usr_u");
    const u = await call(app, "PATCH", `/members/people/${p.id}`, { body: { status: "added", version: l.json.version } });
    expect(u.status).toBe(200);
    expect(idp.calls.map((c) => c.trigger)).toEqual(["member.update"]);
    expect(idp.status.get("usr_u")).toBe("active");
  });

  it("停止中のアカウントは在籍で紐付けても触らない", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_off", "disabled");
    const p = await person(app, "added");
    await link(app, p, "usr_off");
    expect(idp.status.get("usr_off")).toBe("disabled");
  });

  it("冪等: 在籍行を何度保存しても active のまま", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_i", "invited");
    const p = await person(app, "added");
    const l = await link(app, p, "usr_i");
    await call(app, "PATCH", `/members/people/${p.id}`, { body: { contact: "x", version: l.json.version } });
    expect(idp.status.get("usr_i")).toBe("active");
    expect(idp.calls).toHaveLength(2);
  });

  it("公開フォームの参加届はメールが一致してもアカウントを有効化しない", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_victim", "invited");
    const res = await call(app, "POST", "/members/internal/participation", {
      userId: null,
      internal: true,
      body: { lastName: "山田", firstName: "太郎", schoolEmail: "victim@developershub.jp", gmail: "victim@developershub.jp" },
    });
    expect(res.status).toBe(201);
    expect(idp.calls).toEqual([]);
    expect(idp.status.get("usr_victim")).toBe("invited");
  });

  it("identity が落ちていても名簿の保存は成功し、次の保存で再試行される", async () => {
    const { app, idp } = setup();
    idp.status.set("usr_r", "invited");
    idp.fail = true;
    const p = await person(app, "added");
    const l = await link(app, p, "usr_r");
    expect(l.status).toBe(200);
    expect(l.json.identityUserId).toBe("usr_r");
    expect(idp.status.get("usr_r")).toBe("invited");

    idp.fail = false;
    await call(app, "PATCH", `/members/people/${p.id}`, { body: { contact: "retry", version: l.json.version } });
    expect(idp.status.get("usr_r")).toBe("active");
  });

  it("一括付与 (backfill): dryRun は予定だけ、本実行で取り残しを有効化", async () => {
    const idp = new FakeIdentity();
    const roleSync = {
      syncCatalog: async () => ({ dryRun: false, created: [], renamed: [], deleted: [], kept: [] }),
      syncUser: async (_c: unknown, _u: string, r: identity.PutUserManagedRolesRequest) => ({ dryRun: !!r.dryRun, added: [], removed: [], manual: [] }),
    };
    const authz = fakeAuthz(new Set([...adminGrants(), "app:admin:view", "app:admin:edit"] as identity.PermissionKey[]));
    const app = createApp(makeDeps({ identityActivation: idp, roleSync, authz }));
    idp.status.set("usr_left", "invited");
    idp.status.set("usr_invrow", "invited");
    idp.fail = true; // 保存時の有効化が失敗して取り残された状態を作る
    await link(app, await person(app, "added"), "usr_left");
    await link(app, await person(app, "invited"), "usr_invrow");
    idp.fail = false;

    const dry = await call(app, "POST", "/members/role-sync/backfill", { body: { dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.json.activated).toBe(1);
    expect(idp.status.get("usr_left")).toBe("invited");

    const real = await call(app, "POST", "/members/role-sync/backfill", { body: {} });
    expect(real.json).toMatchObject({ dryRun: false, activated: 1, failed: 0 });
    expect(real.json.people.find((x: { identityUserId: string }) => x.identityUserId === "usr_left").activated).toBe(true);
    expect(idp.status.get("usr_left")).toBe("active");
    expect(idp.status.get("usr_invrow")).toBe("invited"); // 名簿が招待中の人は対象外
  });
});
