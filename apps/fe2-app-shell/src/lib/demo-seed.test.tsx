// Demo transport (backend-free showcase). Verifies createDemoFetch auto-logs-in
// with a broad permission session and serves each feature's primary list/detail
// endpoint from seed data, driven end-to-end through the REAL api-client (so the
// mock exercises retry/refresh/error handling, not a bypass). Unknown routes
// still fall through to a NOT_FOUND envelope (in-frame fallback, never blank).
import { describe, expect, it } from "vitest";
import { createApiClient, ApiError } from "./api-client.tsx";
import { createDemoFetch, isDemoEnabled } from "./demo-seed.tsx";

function api() {
  return createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });
}

describe("createDemoFetch", () => {
  it("auto-completes login with a broad-permission session", async () => {
    const me = await api().auth.me();
    expect(me.user.displayName).toBe("デモ 管理者");
    expect(me.permissions).toContain("mail:send");
    expect(me.permissions).toContain("identity:admin");
  });

  it("serves seeded feature lists so every nav item renders data", async () => {
    const a = api();
    const events = await a.events.get<{ items: unknown[] }>("");
    expect(events.items.length).toBeGreaterThan(0);
    const tasks = await a.tasks.get<{ items: unknown[] }>("");
    expect(tasks.items.length).toBeGreaterThan(0);
    const inbox = await a.notifications.get<{ items: unknown[] }>("/inbox");
    expect(inbox.items.length).toBeGreaterThan(0);
    const mail = await a.request<{ items: unknown[] }>({ method: "GET", path: "/api/v1/mail/messages" });
    expect(mail.items.length).toBeGreaterThan(0);
    const users = await a.identity.get<{ items: unknown[] }>("/users");
    expect(users.items.length).toBeGreaterThan(0);
  });

  it("serves detail + benign mutation endpoints (mail read/thread, gantt)", async () => {
    const a = api();
    const thread = await a.request<{ id: string; messages: unknown[] }>({ method: "GET", path: "/api/v1/mail/threads/thr_1" });
    expect(thread.messages.length).toBeGreaterThan(0);
    const read = await a.request<{ read: boolean }>({ method: "POST", path: "/api/v1/mail/messages/msg_1/read", body: {} });
    expect(read.read).toBe(true);
    const gantt = await a.request<{ rows: unknown[] }>({ method: "GET", path: "/api/v1/gantt", query: { event: "evt_1" } });
    expect(gantt.rows.length).toBeGreaterThan(0);
  });

  it("still surfaces NOT_FOUND for un-seeded routes (in-frame fallback)", async () => {
    let caught: unknown;
    try {
      await api().request({ method: "GET", path: "/api/v1/unknown/thing" });
    } catch (e) {
      caught = e;
    }
    expect(ApiError.isApiError(caught)).toBe(true);
    expect((caught as ApiError).status).toBe(404);
  });
});

describe("isDemoEnabled", () => {
  it("is true only for explicit opt-in flags", () => {
    expect(isDemoEnabled({ VITE_DEMO: "1" })).toBe(true);
    expect(isDemoEnabled({ VITE_DEMO: "true" })).toBe(true);
    expect(isDemoEnabled({ VITE_DEMO: "false" })).toBe(false);
    expect(isDemoEnabled({})).toBe(false);
    expect(isDemoEnabled(undefined)).toBe(false);
  });
});

// The admin RBAC console (FE7) drives these endpoints through the demo transport.
// Each `api()` gets a fresh in-session roster store, so mutations here are isolated.
describe("admin RBAC console (interactive roster surface)", () => {
  interface Role { id: string; name: string; permissions: string[]; isSystem: boolean }
  interface Page<T> { items: T[] }
  const roles = (a: ReturnType<typeof api>) => a.request<Page<Role>>({ method: "GET", path: "/api/v1/identity/roles" });

  it("serves the 3 agreed tiers admin / maintainer / member and the 57-key catalog", async () => {
    const a = api();
    const list = await roles(a);
    expect(list.items.map((r) => r.name)).toEqual(["admin", "maintainer", "member"]);
    expect(list.items.every((r) => r.isSystem)).toBe(true);
    const catalog = await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/permissions/catalog" });
    expect(catalog).toHaveLength(57);
  });

  it("① permission-matrix edit: PATCH a system role is rejected, a custom role persists", async () => {
    const a = api();
    // system role is read-only
    let denied: unknown;
    try {
      await a.request({ method: "PATCH", path: "/api/v1/identity/roles/role_member", body: { permissions: ["identity:admin"] } });
    } catch (e) {
      denied = e;
    }
    expect(ApiError.isApiError(denied)).toBe(true);
    expect((denied as ApiError).status).toBe(409);

    // create then edit a custom role — the new permission set is read back
    const created = await a.request<Role>({ method: "POST", path: "/api/v1/identity/roles", body: { name: "広報", permissions: ["event:read"] } });
    const updated = await a.request<Role>({ method: "PATCH", path: `/api/v1/identity/roles/${created.id}`, body: { permissions: ["event:read", "mail:read", "mail:send"] } });
    expect(updated.permissions).toEqual(["event:read", "mail:read", "mail:send"]);
  });

  it("② role add: POST creates a custom role that appears in the list; duplicate name 409s", async () => {
    const a = api();
    const before = (await roles(a)).items.length;
    const created = await a.request<Role>({ method: "POST", path: "/api/v1/identity/roles", body: { name: "会場", permissions: ["file:read"] } });
    expect(created.isSystem).toBe(false);
    expect((await roles(a)).items.length).toBe(before + 1);

    let dup: unknown;
    try {
      await a.request({ method: "POST", path: "/api/v1/identity/roles", body: { name: "会場", permissions: [] } });
    } catch (e) {
      dup = e;
    }
    expect((dup as ApiError).status).toBe(409);
  });

  it("③ user assignment: POST assigns a role, reflected in the user's roles + effective permissions", async () => {
    const a = api();
    // usr_dave starts unassigned (invited)
    const beforeRoles = await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/users/usr_dave/roles" });
    expect(beforeRoles).toHaveLength(0);

    const asg = await a.request<{ id: string; roleName: string }>({ method: "POST", path: "/api/v1/identity/users/usr_dave/roles", body: { roleId: "role_member" } });
    expect(asg.roleName).toBe("member");

    const afterRoles = await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/users/usr_dave/roles" });
    expect(afterRoles).toHaveLength(1);
    const detail = await a.request<{ roleIds: string[]; permissions: string[] }>({ method: "GET", path: "/api/v1/identity/users/usr_dave" });
    expect(detail.roleIds).toContain("role_member");
    expect(detail.permissions).toContain("event:read");

    // revoke it back out
    await a.request({ method: "DELETE", path: `/api/v1/identity/users/usr_dave/roles/${asg.id}` });
    expect(await a.request<unknown[]>({ method: "GET", path: "/api/v1/identity/users/usr_dave/roles" })).toHaveLength(0);
  });

  it("change history (audit) surfaces identity.* actions and grows after a mutation", async () => {
    const a = api();
    const seeded = await a.request<Page<{ action: string }>>({ method: "GET", path: "/api/v1/audit/logs", query: { action: "identity." } });
    expect(seeded.items.length).toBeGreaterThan(0);
    expect(seeded.items.every((r) => r.action.startsWith("identity."))).toBe(true);

    await a.request({ method: "POST", path: "/api/v1/identity/roles", body: { name: "監査テスト", permissions: [] } });
    const after = await a.request<Page<{ action: string }>>({ method: "GET", path: "/api/v1/audit/logs", query: { action: "identity." } });
    expect(after.items.length).toBe(seeded.items.length + 1);
    expect(after.items[0]!.action).toBe("identity.role.created");
  });
});

// メールアドレス管理 (Cloudflare Email Routing @developershub.jp) tab.
describe("admin email routing (@developershub.jp address management)", () => {
  interface Addr { id: string; localPart: string; address: string; destination: string; enabled: boolean }
  interface Page<T> { items: T[] }
  const BASE = "/api/v1/mail/admin/email-routing/addresses";
  const list = (a: ReturnType<typeof api>) => a.request<Page<Addr>>({ method: "GET", path: BASE });

  it("the demo admin holds mail:admin (so the tab is reachable) and lists @developershub.jp addresses", async () => {
    const a = api();
    const me = await a.auth.me();
    expect(me.permissions).toContain("mail:admin");
    const addrs = await list(a);
    expect(addrs.items.length).toBeGreaterThan(0);
    expect(addrs.items.every((x) => x.address.endsWith("@developershub.jp"))).toBe(true);
  });

  it("issue: POST creates an address with only a local part (destination fixed to the mail Worker); bad local part 400", async () => {
    const a = api();
    const before = (await list(a)).items.length;
    // No destination supplied — the forward target is fixed to the mail Worker server-side.
    const created = await a.request<Addr>({ method: "POST", path: BASE, body: { localPart: "events" } });
    expect(created.address).toBe("events@developershub.jp");
    expect(created.enabled).toBe(true);
    expect(created.destination).toBe("mail-gateway (Worker)");
    expect((await list(a)).items.length).toBe(before + 1);

    let e: unknown;
    try {
      await a.request({ method: "POST", path: BASE, body: { localPart: "Bad Space" } });
    } catch (err) {
      e = err;
    }
    expect((e as ApiError).status).toBe(400);
  });

  it("enable/disable via PATCH and delete via DELETE persist", async () => {
    const a = api();
    const target = (await list(a)).items.find((x) => x.enabled)!;
    const toggled = await a.request<Addr>({ method: "PATCH", path: `${BASE}/${target.id}`, body: { enabled: false } });
    expect(toggled.enabled).toBe(false);

    await a.request({ method: "DELETE", path: `${BASE}/${target.id}` });
    expect((await list(a)).items.some((x) => x.id === target.id)).toBe(false);
  });
});
