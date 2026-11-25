// 招待してアカウント (パスワード) を発行しても Web にログインできない、の回帰。
//
// identity の invite は status = invited で作り、password login は active しか通さない。
// 名簿 (member-service) が在籍で紐付いたと確定した時に呼ぶ有効化ポートを、REAL な
// identity-roster の Service Binding に繋いで、gateway 経由の password login が
// 403 -> 200 に変わることを確かめる。
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { createHarness } from "../lib/harness";
import { createIdentityActivation } from "../../services/member-service/src/identityActivation";

const EMAIL = "new.member@developershub.jp";

async function invitedWithPassword() {
  const h = await createHarness();
  const admin = await h.login("admin");
  const inv = await h.gw("POST", "/api/v1/identity/users/invite", { token: admin, body: { email: EMAIL, displayName: "New" } });
  expect(inv.status).toBe(201);
  const user = inv.json<{ user: identity.IdentityUser }>().user;
  expect(user.status).toBe("invited");
  const pw = await h.gw("POST", `/api/v1/admin/users/${user.id}/password`, { token: admin, body: { generate: true, mustChange: false } });
  expect(pw.status).toBe(200);
  const password = pw.json<{ password: string }>().password;
  return { h, user, password, adminId: h.users.admin.userId };
}

describe("invited account activation -> password login", () => {
  it("issued password alone is rejected while invited; activation makes the same login succeed", async () => {
    const { h, user, password, adminId } = await invitedWithPassword();

    const before = await h.gw("POST", "/api/v1/auth/password/login", { body: { email: EMAIL, password } });
    expect(before.status).toBe(403);

    const port = createIdentityActivation(h.identity);
    const res = await port.activate({ requestId: "req_it", userId: adminId }, user.id, { trigger: "member.link" });
    expect(res).toEqual({ dryRun: false, activated: true, previousStatus: "invited", status: "active" });

    const after = await h.gw("POST", "/api/v1/auth/password/login", { body: { email: EMAIL, password } });
    expect(after.status).toBe(200);
    expect(after.json<{ token: string }>().token).toBeTruthy();

    // idempotent over the wire
    const again = await port.activate({ requestId: "req_it2", userId: adminId }, user.id, { trigger: "member.link" });
    expect(again.activated).toBe(false);
  });

  it("a disabled account stays locked out", async () => {
    const { h, user, password, adminId } = await invitedWithPassword();
    const admin = await h.login("admin");
    const dis = await h.gw("PATCH", `/api/v1/identity/users/${user.id}`, { token: admin, body: { status: "disabled" } });
    expect(dis.status).toBe(200);

    const res = await createIdentityActivation(h.identity).activate({ requestId: "req_it", userId: adminId }, user.id, { trigger: "member.link" });
    expect(res).toMatchObject({ activated: false, status: "disabled" });
    const login = await h.gw("POST", "/api/v1/auth/password/login", { body: { email: EMAIL, password } });
    expect(login.status).toBe(403);
  });

  it("the activate route is not reachable through the gateway", async () => {
    const { h, user } = await invitedWithPassword();
    const admin = await h.login("admin");
    const res = await h.gw("POST", `/api/v1/identity/internal/users/${user.id}/activate`, { token: admin, body: { trigger: "x" } });
    expect([403, 404]).toContain(res.status);
    const login = await h.gw("POST", "/api/v1/auth/password/login", { body: { email: EMAIL, password: "whatever-123" } });
    expect(login.status).toBe(403);
  });
});
