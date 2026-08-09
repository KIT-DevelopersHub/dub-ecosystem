import { describe, it, expect, vi } from "vitest";
import { MobileBffClient } from "../src/bff-client";
import { InMemorySessionStore } from "../src/session-store";
import { AppErrorException } from "../src/errors";
import { makeMockServer, errorBody } from "./helpers";

function make(server = makeMockServer(), token: string | null = "tok_1") {
  const store = new InMemorySessionStore();
  if (token) store.setSession(token, "r_1");
  const onLogout = vi.fn();
  const client = new MobileBffClient({ fetchFn: server.fetch, store, onLogout });
  return { client, store, onLogout, server };
}

describe("MobileBffClient — /m/v1 contract calls (§2-1)", () => {
  it("exchange posts code+platform and stores the opaque token", async () => {
    const server = makeMockServer({
      status: 200,
      body: { token: "tok_x", refreshToken: "r_x", session: { userId: "usr_1", client: "mobile", sessionExpiresAt: 1 } },
    });
    const { client, store } = make(server, null);
    const res = await client.exchange("auth_code_123");
    expect(res.token).toBe("tok_x");
    expect(store.getToken()).toBe("tok_x");
    expect(store.getRefreshToken()).toBe("r_x");
    expect(server.requests[0]!.url).toContain("/m/v1/auth/exchange");
    expect(server.requests[0]!.body).toEqual({ code: "auth_code_123", platform: "android" });
  });

  it("getMyTasks hits /tasks?assignee=me with Bearer", async () => {
    const server = makeMockServer({ status: 200, body: { items: [], nextCursor: null } });
    const { client, server: s } = make(server);
    await client.getMyTasks();
    expect(s.requests[0]!.url).toContain("/m/v1/tasks?assignee=me");
    expect(s.requests[0]!.authorization).toBe("Bearer tok_1");
  });

  it("updateTaskStatus PATCHes version+status (single PATCH, theme3 D4)", async () => {
    const task = { id: "tsk_1", version: 4, status: "done", title: "T", eventId: "evt_1" };
    const server = makeMockServer({ status: 200, body: task });
    const { client, server: s } = make(server);
    const res = await client.updateTaskStatus("tsk_1", "done", 3);
    expect(res.version).toBe(4);
    expect(s.requests[0]!.method).toBe("PATCH");
    expect(s.requests[0]!.url).toContain("/m/v1/tasks/tsk_1");
    expect(s.requests[0]!.body).toEqual({ version: 3, status: "done" });
  });

  it("registerDevice posts platform+pushToken and stores server deviceId", async () => {
    const server = makeMockServer({ status: 200, body: { deviceId: "dev_ulid_1" } });
    const { client, store, server: s } = make(server);
    const res = await client.registerDevice("fcm_token_abc");
    expect(res.deviceId).toBe("dev_ulid_1");
    expect(store.getDeviceId()).toBe("dev_ulid_1");
    expect(s.requests[0]!.body).toEqual({ platform: "android", pushToken: "fcm_token_abc" });
  });

  it("logout clears session even when the call is enqueued", async () => {
    const server = makeMockServer({ status: 204 });
    const { client, store } = make(server);
    await client.logout();
    expect(store.getToken()).toBeNull();
  });

  it("logout clears session even if the server errors", async () => {
    const server = makeMockServer({ status: 500, body: errorBody("INTERNAL") });
    const { client, store } = make(server);
    await expect(client.logout()).rejects.toBeInstanceOf(AppErrorException);
    expect(store.getToken()).toBeNull();
  });

  it("transport failure surfaces AppError.Network", async () => {
    const server = makeMockServer({ status: 0, networkError: Object.assign(new Error("offline"), { name: "TypeError" }) });
    const { client } = make(server);
    await expect(client.getHome()).rejects.toMatchObject({ appError: { kind: "Network" } });
  });

  it("204 responses resolve to undefined (markAllRead)", async () => {
    const server = makeMockServer({ status: 204 });
    const { client } = make(server);
    await expect(client.markAllRead()).resolves.toBeUndefined();
  });
});
