// Regression: 運営メンバー・名簿 の書込/閲覧ゲートが per-app キー(app:members:view /
// app:members:edit)を AUTHORITATIVE に受理すること。以前は read=identity:read /
// write=identity:admin 固定だったため、ロール管理で app:members:edit を許可しても
// 実効権限にならず「統括ロールが名簿を開けない/編集できない」不具合になっていた。
//
// enforcement 層(このサービスのミドルウェア)を、fakeAuthz が granted 集合をそのまま
// RBAC 解決結果として返すことで両層まとめて固定する。
import { describe, it, expect } from "vitest";
import { createApp, makeDeps, fakeAuthz, call } from "./harness";
import type { identity } from "@dub/types";

const set = (...keys: identity.PermissionKey[]): Set<identity.PermissionKey> =>
  new Set<identity.PermissionKey>(keys);

describe("member-service RBAC — per-app keys are authoritative for the roster", () => {
  it("app:members:edit (+view) can OPEN and EDIT the roster (200) without identity:admin", async () => {
    // 統括ロール相当: per-app キーのみ保持(ドメイン identity:read/admin は無い)。
    const authz = fakeAuthz(set("app:members:view", "app:members:edit"));
    const app = createApp(makeDeps({ authz }));

    // read: overview 200
    const ov = await call(app, "GET", "/members/overview");
    expect(ov.status).toBe(200);

    // write: create team + person, then edit person — all 200/201
    const team = await call(app, "POST", "/members/teams", { body: { name: "会場" } });
    expect(team.status).toBe(201);

    const person = await call(app, "POST", "/members/people", {
      body: { name: "山田太郎", status: "added", teamIds: [team.json.id] },
    });
    expect(person.status).toBe(201);

    const edit = await call(app, "PATCH", `/members/people/${person.json.id}`, {
      body: { status: "invited", version: person.json.version },
    });
    expect(edit.status).toBe(200);
    expect(edit.json.status).toBe("invited");
  });

  it("app:members:view ONLY can read (200) but NOT edit (403)", async () => {
    const authz = fakeAuthz(set("app:members:view"));
    const app = createApp(makeDeps({ authz }));

    const ov = await call(app, "GET", "/members/overview");
    expect(ov.status).toBe(200);

    // create team / person は書込ゲート → 403
    const team = await call(app, "POST", "/members/teams", { body: { name: "広報" } });
    expect(team.status).toBe(403);
    const person = await call(app, "POST", "/members/people", { body: { name: "花子", status: "added", teamIds: [] } });
    expect(person.status).toBe(403);
  });

  it("revoking the app key (no keys) → read AND write are 403", async () => {
    const authz = fakeAuthz(set());
    const app = createApp(makeDeps({ authz }));
    expect((await call(app, "GET", "/members/overview")).status).toBe(403);
    expect((await call(app, "POST", "/members/teams", { body: { name: "x" } })).status).toBe(403);
  });

  it("domain keys still work (backward compat): identity:read reads, identity:admin writes", async () => {
    const readOnly = createApp(makeDeps({ authz: fakeAuthz(set("identity:read")) }));
    expect((await call(readOnly, "GET", "/members/overview")).status).toBe(200);
    // identity:read alone cannot write
    expect((await call(readOnly, "POST", "/members/teams", { body: { name: "x" } })).status).toBe(403);

    const adminWrite = createApp(makeDeps({ authz: fakeAuthz(set("identity:admin")) }));
    expect((await call(adminWrite, "POST", "/members/teams", { body: { name: "会場" } })).status).toBe(201);
  });

  it("no over-escalation: app:members:edit does NOT unlock 参加届 resolve (identity:admin)", async () => {
    // 参加届 resolve は別アプリ面 → identity:admin のまま。名簿編集者が勝手に届出審査に
    // 昇格しないこと(ゲートはハンドラ前に走るので id 実在は問わない)。
    const authz = fakeAuthz(set("app:members:view", "app:members:edit"));
    const app = createApp(makeDeps({ authz }));
    const res = await call(app, "POST", "/members/participation/part_x/resolve", {
      body: { action: "skip" },
    });
    expect(res.status).toBe(403);
  });
});
