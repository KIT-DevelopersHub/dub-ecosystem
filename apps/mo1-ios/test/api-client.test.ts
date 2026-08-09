import { describe, it, expect } from "vitest";
import { MobileApiClient } from "../src/api-client.js";
import { InMemoryTokenStore } from "../src/token-store.js";
import type { DubClientError } from "../src/errors.js";
import { ok, errBody, scriptedTransport } from "./helpers.js";

const BASE = "https://m-api.developershub.jp";
const noSleep = async (): Promise<void> => {};

function seededStore(token = "tok-1") {
  const store = new InMemoryTokenStore();
  store.write({ token, sessionExpiresAt: Date.now() + 3_600_000 });
  return store;
}

describe("MobileApiClient core (design §2-2, §6 / test §7 ApiClient)", () => {
  it("attaches the Bearer token and hits /m/v1/*", async () => {
    const store = seededStore("abc");
    const { transport, calls } = scriptedTransport([ok({ upcomingEvents: [], myTasks: [], unreadCount: 0 })]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    await client.getHome();

    expect(calls[0]!.url).toBe(`${BASE}/m/v1/bff/home`);
    expect(calls[0]!.headers.authorization).toBe("Bearer abc");
  });

  it("on 401 does ONE silent refresh then retries once (design §6 1回性)", async () => {
    const store = seededStore("stale");
    const refreshed = { token: "fresh", session: { userId: "u1", client: "mobile", sessionExpiresAt: 9_999_999_999_999 } };
    const { transport, calls } = scriptedTransport([
      ok(errBody("UNAUTHENTICATED"), 401), // 1: original call -> 401
      ok(refreshed), // 2: /auth/refresh -> new token
      ok({ upcomingEvents: [], myTasks: [], unreadCount: 2 }), // 3: retry -> 200
    ]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    const home = await client.getHome();

    expect(home.unreadCount).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe(`${BASE}/m/v1/auth/refresh`);
    expect(calls[1]!.headers.authorization).toBe("Bearer stale"); // refresh uses current token
    expect(calls[2]!.headers.authorization).toBe("Bearer fresh"); // retry uses refreshed token
    expect(store.read()!.token).toBe("fresh");
  });

  it("does NOT retry a second time: 401 -> refresh -> still 401 clears session", async () => {
    const store = seededStore("stale");
    const onSessionExpired = { count: 0 };
    const { transport, calls } = scriptedTransport([
      ok(errBody("UNAUTHENTICATED"), 401), // original
      ok({ token: "fresh", session: { userId: "u1", client: "mobile", sessionExpiresAt: 1 } }), // refresh ok
      ok(errBody("UNAUTHENTICATED"), 401), // retry still 401
    ]);
    const client = new MobileApiClient({
      baseUrl: BASE,
      transport,
      tokenStore: store,
      sleep: noSleep,
      onSessionExpired: () => (onSessionExpired.count += 1),
    });

    await expect(client.getHome()).rejects.toMatchObject({ kind: "reauth" });
    expect(calls).toHaveLength(3); // no third data attempt
    expect(store.read()).toBeNull(); // Keychain cleared
    expect(onSessionExpired.count).toBe(1);
  });

  it("routes to login when refresh itself fails", async () => {
    const store = seededStore("stale");
    const { transport } = scriptedTransport([
      ok(errBody("UNAUTHENTICATED"), 401),
      ok(errBody("AUTH_REFRESH_REJECTED"), 401), // refresh rejected
    ]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    await expect(client.getHome()).rejects.toMatchObject({ kind: "reauth" });
    expect(store.read()).toBeNull();
  });

  it("retries retryable upstream errors with backoff, up to maxRetries", async () => {
    const store = seededStore();
    const { transport, calls } = scriptedTransport([
      ok(errBody("UPSTREAM_UNAVAILABLE", "down", { retryable: true }), 502),
      ok(errBody("UPSTREAM_UNAVAILABLE", "down", { retryable: true }), 502),
      ok({ upcomingEvents: [], myTasks: [], unreadCount: 0 }),
    ]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep, maxRetries: 2 });

    await client.getHome();
    expect(calls).toHaveLength(3);
  });

  it("surfaces the error after exhausting retries", async () => {
    const store = seededStore();
    const { transport, calls } = scriptedTransport([ok(errBody("UPSTREAM_TIMEOUT", "t", { retryable: true }), 504)]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep, maxRetries: 2 });

    await expect(client.getHome()).rejects.toMatchObject({ kind: "upstream" });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it("maps a transport throw to an offline error after retries", async () => {
    const store = seededStore();
    const { transport } = scriptedTransport([new Error("no network")]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep, maxRetries: 1 });

    await expect(client.getHome()).rejects.toMatchObject({ kind: "offline" });
  });

  it("does not attach Bearer nor refresh on anonymous exchange", async () => {
    const store = new InMemoryTokenStore();
    const { transport, calls } = scriptedTransport([
      ok({ token: "t", session: { userId: "u1", client: "mobile", sessionExpiresAt: 1 } }),
    ]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    await client.exchange({ code: "auth-code" });
    expect(calls[0]!.url).toBe(`${BASE}/m/v1/auth/exchange`);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("logout clears the Keychain even if the server call fails", async () => {
    const store = seededStore("bye");
    const { transport } = scriptedTransport([new Error("offline")]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep, maxRetries: 0 });

    await client.logout();
    expect(store.read()).toBeNull();
  });

  it("builds task list query strings from ListTasksQuery", async () => {
    const store = seededStore();
    const { transport, calls } = scriptedTransport([ok({ items: [], nextCursor: null })]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    await client.listTasks({ assigneeId: "me", limit: 20 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/m/v1/tasks");
    expect(url.searchParams.get("assigneeId")).toBe("me");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("PATCH task sends the version for optimistic locking", async () => {
    const store = seededStore();
    const { transport, calls } = scriptedTransport([ok({ id: "task_1", version: 5, status: "done" })]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    await client.patchTask("task_1", { version: 4, status: "done" });
    expect(calls[0]!.method).toBe("PATCH");
    expect((calls[0]!.body as { version: number }).version).toBe(4);
  });

  it("throws a conflict DubClientError on 409 version mismatch", async () => {
    const store = seededStore();
    const { transport } = scriptedTransport([ok(errBody("TASK_VERSION_CONFLICT", "stale", {}), 409)]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    const err = (await client.patchTask("t1", { version: 1, status: "done" }).catch((e) => e)) as DubClientError;
    expect(err.kind).toBe("conflict");
    expect(err.code).toBe("TASK_VERSION_CONFLICT");
  });
});
