import { describe, it, expect } from "vitest";
import { DubError } from "@dub/errors";
import { HDR_INTERNAL, HDR_USER_ID } from "@dub/observability";
import { buildApp } from "../src/app";
import { makeHarness, jsonInit, authHeaders, GOOD_TOKEN, ALICE } from "./helpers";

describe("health", () => {
  it("GET /healthz is public", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "mobile-bff" });
  });
});

describe("auth entry guard", () => {
  it("401 when no bearer token on a protected route", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/m/v1/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("401 when verify rejects the token (expired)", async () => {
    const h = makeHarness();
    h.authenticator.verifyResult = { valid: false, userId: null, session: null, reason: "expired" };
    const res = await buildApp(h.deps).request("/m/v1/me", { headers: authHeaders() });
    expect(res.status).toBe(401);
  });

  it("does not trust a spoofed x-dub-user-id (no bearer still 401)", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/m/v1/me", { headers: { [HDR_USER_ID]: "usr_attacker" } });
    expect(res.status).toBe(401);
  });
});

describe("mobile OAuth delegation (token透過)", () => {
  it("POST /m/v1/auth/exchange delegates to auth /mobile/exchange", async () => {
    const h = makeHarness();
    const session = { userId: ALICE, client: "mobile", sessionExpiresAt: 111 };
    h.auth.on("POST", "/mobile/exchange", { token: "sess_new", session });
    const res = await buildApp(h.deps).request("/m/v1/auth/exchange", jsonInit({ code: "abc123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "sess_new", session });
    expect(h.auth.calls[0]).toMatchObject({ method: "POST", path: "/mobile/exchange", body: { code: "abc123" } });
  });

  it("POST /m/v1/auth/refresh forwards the inbound bearer as refreshToken", async () => {
    const h = makeHarness();
    h.auth.on("POST", "/auth/refresh", { token: "sess_rot", session: {} });
    const res = await buildApp(h.deps).request("/m/v1/auth/refresh", {
      method: "POST",
      headers: authHeaders("old_token"),
    });
    expect(res.status).toBe(200);
    expect(h.auth.calls[0]).toMatchObject({ path: "/auth/refresh", body: { refreshToken: "old_token" } });
  });

  it("POST /m/v1/auth/logout (本人) delegates the token", async () => {
    const h = makeHarness();
    h.auth.on("POST", "/auth/logout", { ok: true });
    const res = await buildApp(h.deps).request("/m/v1/auth/logout", { method: "POST", headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(h.auth.calls[0]).toMatchObject({ path: "/auth/logout", body: { token: GOOD_TOKEN } });
  });
});

describe("/m/v1/me", () => {
  it("aggregates identity detail for the verified user", async () => {
    const h = makeHarness();
    h.identity.on("GET", `/users/${ALICE}`, { id: ALICE, displayName: "Alice" });
    const res = await buildApp(h.deps).request("/m/v1/me", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(ALICE);
    expect(h.identity.calls[0]?.path).toBe(`/users/${ALICE}`);
  });
});

describe("devices", () => {
  it("register -> list -> delete lifecycle (deviceId server-minted)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);

    const reg = await app.request("/m/v1/devices", jsonInit({ platform: "ios", pushToken: "tokA" }, authHeaders()));
    expect(reg.status).toBe(201);
    const { deviceId } = (await reg.json()) as { deviceId: string };
    expect(deviceId).toMatch(/^mdev_/);

    const list = await app.request("/m/v1/devices", { headers: authHeaders() });
    const { devices } = (await list.json()) as { devices: { id: string; platform: string }[] };
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: deviceId, platform: "ios" });

    const del = await app.request(`/m/v1/devices/${deviceId}`, { method: "DELETE", headers: authHeaders() });
    expect(del.status).toBe(204);

    const list2 = await app.request("/m/v1/devices", { headers: authHeaders() });
    expect(((await list2.json()) as { devices: unknown[] }).devices).toHaveLength(0);
  });

  it("re-registering the same token by another user hands the device off", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    await app.request("/m/v1/devices", jsonInit({ platform: "ios", pushToken: "shared" }, authHeaders()));

    h.authenticator.verifyResult = {
      valid: true,
      userId: "usr_bob",
      session: { userId: "usr_bob", client: "mobile", sessionExpiresAt: Date.now() + 1000 },
      reason: null,
    };
    await app.request("/m/v1/devices", jsonInit({ platform: "ios", pushToken: "shared" }, authHeaders()));

    expect(await h.devices.listActiveByUser(ALICE)).toHaveLength(0); // old owner loses push
    expect(await h.devices.listActiveByUser("usr_bob")).toHaveLength(1);
    expect(h.devices.rows.size).toBe(1); // reassigned, not duplicated
  });

  it("DELETE of an unknown device -> 404 MOBILE_DEVICE_NOT_FOUND", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/m/v1/devices/mdev_missing", { method: "DELETE", headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MOBILE_DEVICE_NOT_FOUND");
  });

  it("register with an invalid platform -> 400 VALIDATION_FAILED", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/m/v1/devices", jsonInit({ platform: "windows", pushToken: "x" }, authHeaders()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });
});

describe("transparent proxy", () => {
  it("GET /m/v1/tasks forwards to task-service with query, passes body through", async () => {
    const h = makeHarness();
    h.task.on("GET", "/tasks", { items: [{ id: "tsk_1", title: "T", status: "todo", assigneeId: ALICE }], nextCursor: null });
    const res = await buildApp(h.deps).request("/m/v1/tasks?status=todo", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(h.task.calls[0]?.opts?.query).toMatchObject({ status: "todo" });
  });

  it("PATCH /m/v1/tasks/:id transparently passes the task-service 409 version conflict", async () => {
    const h = makeHarness();
    h.task.on("PATCH", "/tasks/tsk_1", new DubError("TASK_VERSION_CONFLICT", "version mismatch", { status: 409 }));
    const res = await buildApp(h.deps).request("/m/v1/tasks/tsk_1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ version: 1, title: "x" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_VERSION_CONFLICT");
  });
});

describe("BFF home", () => {
  it("aggregates events + tasks + unread; tolerates partial upstream failure", async () => {
    const h = makeHarness();
    h.event.on("GET", "/events", { items: [{ id: "evt_1", title: "E", phase: "planning", startsAt: null }], nextCursor: null });
    h.task.on("GET", "/tasks", new DubError("UPSTREAM_UNAVAILABLE", "down", { status: 502 })); // partial failure
    h.notification.on("GET", "/inbox/unread-count", { count: 3 });

    const res = await buildApp(h.deps).request("/m/v1/bff/home", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upcomingEvents: unknown[]; myTasks: unknown[]; unreadCount: number };
    expect(body.upcomingEvents).toHaveLength(1);
    expect(body.myTasks).toHaveLength(0); // defaulted on failure, request still 200
    expect(body.unreadCount).toBe(3);
  });
});

describe("BFF event overview", () => {
  it("returns event summary + resource-scoped capabilities", async () => {
    const h = makeHarness();
    h.event.on("GET", "/events/evt_1", { id: "evt_1", title: "E", phase: "live", startsAt: null, actions: [] });
    h.authenticator.caps = ["event:read", "event:write"];
    const res = await buildApp(h.deps).request("/m/v1/bff/events/evt_1", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { id: string; phase: string }; capabilities: string[] };
    expect(body.event).toEqual({ id: "evt_1", title: "E", phase: "live", startsAt: null });
    expect(body.capabilities).toEqual(["event:read", "event:write"]);
    expect(h.authenticator.capabilityCalls[0]?.scope).toEqual({ resourceType: "event", resourceId: "evt_1" });
  });
});

describe("sync / mutations (wired)", () => {
  it("GET /m/v1/sync -> 200 with a differential envelope (cursor + serverTime)", async () => {
    const h = makeHarness();
    h.event.on("GET", "/events", { items: [{ id: "evt_1", title: "E", phase: "live", startsAt: null }], nextCursor: null });
    h.task.on("GET", "/tasks", { items: [], nextCursor: null });
    h.notification.on("GET", "/inbox", { items: [], nextCursor: null });

    const res = await buildApp(h.deps).request("/m/v1/sync", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { resource: string; id: string }[]; nextCursor: string; serverTime: string };
    expect(body.items).toEqual([{ resource: "event", id: "evt_1", data: { id: "evt_1", title: "E", phase: "live", startsAt: null } }]);
    expect(typeof body.nextCursor).toBe("string");
    expect(typeof body.serverTime).toBe("string");
  });

  it("POST /m/v1/mutations -> 200 applies a task update and returns its result", async () => {
    const h = makeHarness();
    h.task.on("PATCH", "/tasks/tsk_1", { id: "tsk_1", version: 2 });
    const res = await buildApp(h.deps).request(
      "/m/v1/mutations",
      jsonInit({ mutations: [{ idempotencyKey: "k1", op: "task.update", id: "tsk_1", patch: { version: 1, title: "x" } }] }, authHeaders()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { idempotencyKey: string; status: string; resource?: { id: string } }[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ idempotencyKey: "k1", status: "applied", resource: { id: "tsk_1" } });
  });

  it("both endpoints still require auth (401 without bearer)", async () => {
    const h = makeHarness();
    const app = buildApp(h.deps);
    expect((await app.request("/m/v1/sync")).status).toBe(401);
    expect((await app.request("/m/v1/mutations", { method: "POST" })).status).toBe(401);
  });
});

describe("internal push dispatch", () => {
  async function seedDevice(h: ReturnType<typeof makeHarness>): Promise<void> {
    await h.devices.upsertByToken({ userId: ALICE, platform: "ios", pushToken: "tokP" });
  }

  it("403 without the x-dub-internal Service-Binding marker", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request(
      "/internal/push/dispatch",
      jsonInit({ userId: ALICE, type: "task.assigned", payload: { title: "t", body: "b" } }),
    );
    expect(res.status).toBe(403);
  });

  it("202 + fans out to active devices, marks delivery sent", async () => {
    const h = makeHarness();
    await seedDevice(h);
    const res = await buildApp(h.deps).request(
      "/internal/push/dispatch",
      jsonInit(
        { notificationId: "ntf_1", userId: ALICE, type: "task.assigned", payload: { title: "t", body: "b" } },
        { [HDR_INTERNAL]: "1" },
      ),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, deviceCount: 1 });
    expect(h.ios.sends).toHaveLength(1);
    expect(h.deliveries.records[0]?.status).toBe("sent");
  });

  it("202 + deviceCount 0 when the user has no devices (not an error)", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request(
      "/internal/push/dispatch",
      jsonInit(
        { userId: "usr_nobody", type: "task.assigned", payload: { title: "t", body: "b" } },
        { [HDR_INTERNAL]: "1" },
      ),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, deviceCount: 0 });
  });
});
