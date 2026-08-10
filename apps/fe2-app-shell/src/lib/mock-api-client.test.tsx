// mock transport (offline shell boot). Verifies createMockFetch answers the
// shell boot surface from seed data, that unknown routes become a NOT_FOUND
// envelope (so feature screens show in-frame fallbacks, not a white screen),
// and that it composes with the REAL api-client (retry/refresh/error handling
// run unchanged over the swapped transport).
import { describe, expect, it } from "vitest";
import { createApiClient, ApiError } from "./api-client.tsx";
import { createMockFetch, isMockEnabled } from "./mock-api-client.tsx";

describe("createMockFetch", () => {
  it("serves /me and /bff/home from default seed data", async () => {
    const f = createMockFetch();
    const me = await (await f("https://x/api/v1/me")).json();
    expect(me.user.displayName).toBe("デモ ユーザー");
    const home = await (await f("https://x/api/v1/bff/home")).json();
    expect(home.upcomingEvents.length).toBeGreaterThan(0);
    expect(home.unreadCount).toBe(2);
    expect(home.partialErrors).toEqual([]);
  });

  it("honors seed overrides", async () => {
    const f = createMockFetch({
      home: { upcomingEvents: [], unreadCount: 0, partialErrors: [] },
    });
    const home = await (await f("https://x/api/v1/bff/home")).json();
    expect(home.unreadCount).toBe(0);
    // default me is untouched when only home is overridden
    const me = await (await f("https://x/api/v1/me")).json();
    expect(me.orgId).toBe("org_demo");
  });

  it("returns 204 for logout and a NOT_FOUND envelope for unknown routes", async () => {
    const f = createMockFetch();
    const logout = await f("https://x/api/v1/auth/logout", { method: "POST" });
    expect(logout.status).toBe(204);
    const miss = await f("https://x/api/v1/events/evt_1", { method: "GET" });
    expect(miss.status).toBe(404);
    const body = await miss.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("drives the real api-client end-to-end over the mock transport", async () => {
    const api = createApiClient({ baseUrl: "https://mock.local", fetchImpl: createMockFetch() });
    const me = await api.auth.me();
    expect(me.permissions).toContain("notif:inbox:self");
    const home = await api.bff.home();
    expect(home.unreadCount).toBe(2);
    // Unknown feature route surfaces as a normalized ApiError (NOT_FOUND).
    let caught: unknown;
    try {
      await api.events.get("/evt_1");
    } catch (e) {
      caught = e;
    }
    expect(ApiError.isApiError(caught)).toBe(true);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).code).toBe("NOT_FOUND");
  });
});

describe("isMockEnabled", () => {
  it("is true only for explicit opt-in flags", () => {
    expect(isMockEnabled({ VITE_API_MOCK: "true" })).toBe(true);
    expect(isMockEnabled({ VITE_API_MOCK: "1" })).toBe(true);
    expect(isMockEnabled({ VITE_API_MOCK: "false" })).toBe(false);
    expect(isMockEnabled({})).toBe(false);
    expect(isMockEnabled(undefined)).toBe(false);
  });
});
