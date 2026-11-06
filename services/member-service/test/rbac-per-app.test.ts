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
    const authz = fakeAuthz(set("app:members:view", "app:members:edit", "members:roster_view", "members:roster_edit"));
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
    const authz = fakeAuthz(set("app:members:view", "members:roster_view"));
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

  // The per-app tier is now the WHOLE gate on both axes — the former read gate was
  // `requireAny(["identity:read", "app:members:view"])` (OR) and @dub/policy-gate has no OR
  // form (docs/policy-coverage-inventory.md b-6). Collapsing it to the tier loses nobody in
  // real data: identity migration 0010_app_access_policy_backfill.sql:40-41 grants
  // app:members:view to every role holding identity:read, and identity-roster/src/seed.ts:31
  // (`{ id: "members", read: "identity:read" }`) derives the same key for every role seeded
  // since. A key set with identity:read and NO app:members:view therefore cannot exist in a
  // deployed org — it is the stale shape this test pins as closed.
  it("the 運営メンバー tier is the whole gate: identity:read / identity:admin alone reach nothing", async () => {
    const domainReadOnly = createApp(makeDeps({ authz: fakeAuthz(set("identity:read")) }));
    expect((await call(domainReadOnly, "GET", "/members/overview")).status).toBe(403);
    expect((await call(domainReadOnly, "POST", "/members/teams", { body: { name: "x" } })).status).toBe(403);

    // The 3 段階 is AUTHORITATIVE for writes: a role holding the domain key but NO
    // app:members:edit is 閲覧 (or 無効) on 運営メンバー, so its writes are rejected server-side —
    // the whole point of "閲覧 にしたらボタンも API も通らない".
    const adminOnly = createApp(makeDeps({ authz: fakeAuthz(set("identity:admin")) }));
    expect((await call(adminOnly, "POST", "/members/teams", { body: { name: "会場" } })).status).toBe(403);

    // What migration 0010 actually produces for a role that could write before: both keys.
    const backfilled = createApp(makeDeps({ authz: fakeAuthz(set("identity:admin", "app:members:view", "app:members:edit", "members:roster_view")) }));
    expect((await call(backfilled, "GET", "/members/overview")).status).toBe(200);
    expect((await call(backfilled, "POST", "/members/teams", { body: { name: "会場" } })).status).toBe(201);

    // ...and what it produces for a plain reader (member/organizer/maintainer): the view key.
    const seededReader = createApp(makeDeps({ authz: fakeAuthz(set("identity:read", "app:members:view", "members:roster_view")) }));
    expect((await call(seededReader, "GET", "/members/overview")).status).toBe(200);
    expect((await call(seededReader, "POST", "/members/teams", { body: { name: "x" } })).status).toBe(403);
  });

  it("no over-escalation: app:members:edit does NOT unlock 参加届 resolve (identity:admin)", async () => {
    // 参加届 resolve は別アプリ面 → identity:admin のまま。名簿編集者が勝手に届出審査に
    // 昇格しないこと(ゲートはハンドラ前に走るので id 実在は問わない)。
    const authz = fakeAuthz(set("app:members:view", "app:members:edit", "members:roster_view", "members:roster_edit"));
    const app = createApp(makeDeps({ authz }));
    const res = await call(app, "POST", "/members/participation/part_x/resolve", {
      body: { action: "skip" },
    });
    expect(res.status).toBe(403);
  });
});

describe("member-service RBAC — 運営メンバーの範囲", () => {
  const ORG_CHART_VIEW = set("app:members:view");
  const ORG_CHART_EDIT = set("app:members:view", "app:members:edit");
  const ROSTER_EDIT = set("app:members:view", "app:members:edit", "members:roster_view", "members:roster_edit");

  async function seededPerson() {
    const app = createApp(makeDeps({ authz: fakeAuthz(ROSTER_EDIT) }));
    const person = await call(app, "POST", "/members/people", {
      body: { name: "山田太郎", status: "added", teamIds: [], phone: "090-1234-5678", gmail: "yamada@gmail.com", note: "内緒" },
    });
    expect(person.status).toBe(201);
    return { app, person: person.json };
  }

  it("組織図まで: overview は 403、org-overview は個人情報なしの行を返す", async () => {
    const deps = makeDeps({ authz: fakeAuthz(ROSTER_EDIT) });
    const writer = createApp(deps);
    await call(writer, "POST", "/members/people", {
      body: { name: "山田太郎", status: "added", teamIds: [], phone: "090-1234-5678", gmail: "yamada@gmail.com", note: "内緒" },
    });
    const app = createApp({ ...deps, authz: fakeAuthz(ORG_CHART_VIEW) });
    expect((await call(app, "GET", "/members/overview")).status).toBe(403);
    expect((await call(app, "GET", "/members/people/by-identity/usr_x")).status).toBe(403);

    const org = await call(app, "GET", "/members/org-overview");
    expect(org.status).toBe(200);
    const [row] = org.json.members;
    expect(row.name).toBe("山田太郎");
    expect(row.phone).toBeNull();
    expect(row.gmail).toBeNull();
    expect(row.note).toBeNull();
    expect(JSON.stringify(org.json)).not.toContain("090-1234-5678");
  });

  it("組織図までの編集: /org は運営での項目だけ反映し、本人の情報は無視して返さない", async () => {
    const deps = makeDeps({ authz: fakeAuthz(ROSTER_EDIT) });
    const writer = createApp(deps);
    const created = await call(writer, "POST", "/members/people", {
      body: { name: "山田太郎", status: "added", teamIds: [], phone: "090-1234-5678" },
    });
    const app = createApp({ ...deps, authz: fakeAuthz(ORG_CHART_EDIT) });

    const denied = await call(app, "PATCH", `/members/people/${created.json.id}`, {
      body: { phone: "000", version: created.json.version },
    });
    expect(denied.status).toBe(403);

    const ok = await call(app, "PATCH", `/members/people/${created.json.id}/org`, {
      body: { roleTitle: "会場リーダー", phone: "000", version: created.json.version },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.roleTitle).toBe("会場リーダー");
    expect(ok.json.phone).toBeNull();

    const full = await call(writer, "GET", "/members/overview");
    expect(full.json.members[0].phone).toBe("090-1234-5678");
  });

  it("3 段階が閲覧なら /org も 403", async () => {
    const { person } = await seededPerson();
    const app = createApp(makeDeps({ authz: fakeAuthz(ORG_CHART_VIEW) }));
    const res = await call(app, "PATCH", `/members/people/${person.id}/org`, { body: { roleTitle: "x", version: person.version } });
    expect(res.status).toBe(403);
  });
});
