// Demo transport (backend-free showcase). Verifies createDemoFetch gates /me
// behind a credential login (admin / member) and serves each feature's primary
// list/detail endpoint from seed data, driven end-to-end through the REAL
// api-client (so the mock exercises retry/refresh/error handling, not a bypass).
// Unknown routes still fall through to a NOT_FOUND envelope (never blank).
import { beforeEach, describe, expect, it } from "vitest";
import { createApiClient, ApiError } from "./api-client.tsx";
import { createDemoFetch, demoLogin, demoLogout, isDemoEnabled } from "./demo-seed.tsx";

function api() {
  return createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });
}

describe("createDemoFetch", () => {
  beforeEach(() => demoLogout());

  it("gates /me behind login: 401 when logged out (→ redirect to /login)", async () => {
    let caught: unknown;
    try {
      await api().auth.me();
    } catch (e) {
      caught = e;
    }
    expect(ApiError.isApiError(caught)).toBe(true);
    expect((caught as ApiError).status).toBe(401);
  });

  it("admin credentials unlock a broad-permission session", async () => {
    expect(demoLogin("admin@dub.local", "demo-admin-pw")).toBe(true);
    const me = await api().auth.me();
    expect(me.user.displayName).toBe("デモ 管理者");
    expect(me.permissions).toContain("mail:send");
    expect(me.permissions).toContain("identity:admin");
  });

  it("member credentials unlock a read-mostly session without admin scopes", async () => {
    expect(demoLogin("member@dub.local", "demo-member-pw")).toBe(true);
    const me = await api().auth.me();
    expect(me.user.displayName).toBe("デモ 一般メンバー");
    expect(me.permissions).toContain("event:read");
    expect(me.permissions).not.toContain("identity:admin");
    expect(me.permissions).not.toContain("mail:send");
  });

  it("rejects wrong credentials and logout clears the session", async () => {
    expect(demoLogin("admin@dub.local", "wrong")).toBe(false);
    expect(demoLogin("nobody@dub.local", "demo-admin-pw")).toBe(false);
    demoLogin("admin@dub.local", "demo-admin-pw");
    demoLogout();
    let status = 0;
    try {
      await api().auth.me();
    } catch (e) {
      status = ApiError.isApiError(e) ? e.status : -1;
    }
    expect(status).toBe(401);
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
