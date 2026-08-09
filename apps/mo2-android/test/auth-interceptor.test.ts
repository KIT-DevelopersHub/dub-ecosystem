import { describe, it, expect, vi } from "vitest";
import { MobileBffClient } from "../src/bff-client";
import { InMemorySessionStore } from "../src/session-store";
import { AppErrorException } from "../src/errors";
import { makeMockServer, errorBody } from "./helpers";

function setup(server = makeMockServer()) {
  const store = new InMemorySessionStore();
  store.setSession("tok_old", "refresh_1");
  const onLogout = vi.fn();
  const client = new MobileBffClient({ fetchFn: server.fetch, store, onLogout });
  return { store, onLogout, client, server };
}

describe("AuthInterceptor — single token 401 refresh+retry (§6/§7)", () => {
  it("401 -> refresh once -> retry with new token -> success", async () => {
    const server = makeMockServer(
      { status: 401, body: errorBody("AUTH_INVALID_TOKEN") }, // first home
      { status: 200, body: { token: "tok_new", refreshToken: "refresh_2", session: {} } }, // refresh
      { status: 200, body: { upcomingEvents: [], myTasks: [], unreadCount: 0 } }, // retry home
    );
    const { client, store, onLogout } = setup(server);

    const home = await client.getHome();
    expect(home.unreadCount).toBe(0);
    expect(store.getToken()).toBe("tok_new"); // rotated
    expect(store.getRefreshToken()).toBe("refresh_2");
    expect(onLogout).not.toHaveBeenCalled();

    // request 1 used old bearer, refresh posted, request 3 used new bearer
    expect(server.requests[0]!.authorization).toBe("Bearer tok_old");
    expect(server.requests[1]!.url).toContain("/m/v1/auth/refresh");
    expect(server.requests[1]!.body).toEqual({ refreshToken: "refresh_1" });
    expect(server.requests[2]!.authorization).toBe("Bearer tok_new");
  });

  it("refresh failure -> logout + clears session + rethrows Unauthorized", async () => {
    const server = makeMockServer(
      { status: 401, body: errorBody("AUTH_INVALID_TOKEN") },
      { status: 401, body: errorBody("AUTH_REFRESH_REUSED") }, // refresh rejected
    );
    const { client, store, onLogout } = setup(server);

    await expect(client.getHome()).rejects.toBeInstanceOf(AppErrorException);
    expect(onLogout).toHaveBeenCalledOnce();
    expect(store.getToken()).toBeNull();
  });

  it("no refresh token -> immediate logout, no refresh call", async () => {
    const server = makeMockServer({ status: 401, body: errorBody("AUTH_INVALID_TOKEN") });
    const store = new InMemorySessionStore();
    store.setSession("tok_only", null);
    const onLogout = vi.fn();
    const client = new MobileBffClient({ fetchFn: server.fetch, store, onLogout });

    await expect(client.getHome()).rejects.toBeInstanceOf(AppErrorException);
    expect(onLogout).toHaveBeenCalledOnce();
    expect(server.requests).toHaveLength(1); // no refresh attempted
  });

  it("second 401 after successful refresh -> logout", async () => {
    const server = makeMockServer(
      { status: 401, body: errorBody("AUTH_INVALID_TOKEN") },
      { status: 200, body: { token: "tok_new", refreshToken: "refresh_2", session: {} } },
      { status: 401, body: errorBody("AUTH_INVALID_TOKEN") }, // retry still 401
    );
    const { client, onLogout } = setup(server);
    await expect(client.getHome()).rejects.toBeInstanceOf(AppErrorException);
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
