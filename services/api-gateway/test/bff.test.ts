import { describe, it, expect } from "vitest";
import type { gateway } from "@dub/types";
import { createApp } from "../src/app";
import { fakeBinding, authBinding, validSession, json, failingBinding, makeEnv, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const app = () => createApp(NO_RL);

const eventsOk = () =>
  fakeBinding(() =>
    json(200, { items: [{ id: "evt_1", title: "Conf", phase: "open", startsAt: "2026-09-01T00:00:00Z" }], nextCursor: null }),
  );
const unreadOk = () => fakeBinding(() => json(200, { count: 7 }));

describe("GET /api/v1/bff/home", () => {
  it("[case9] all sources succeed -> full DTO, empty partialErrors", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding(validSession()).fetcher, SVC_EVENT: eventsOk().fetcher, SVC_NOTIFICATION: unreadOk().fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/bff/home", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gateway.BffHomeResponse;
    expect(body.upcomingEvents).toHaveLength(1);
    expect(body.unreadCount).toBe(7);
    expect(body.partialErrors).toEqual([]);
  });

  it("[case9] one source failing -> 200 with partialErrors entry", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding(validSession()).fetcher, SVC_EVENT: eventsOk().fetcher, SVC_NOTIFICATION: failingBinding("throw") });
    const res = await app().fetch(new Request("https://x/api/v1/bff/home", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gateway.BffHomeResponse;
    expect(body.upcomingEvents).toHaveLength(1);
    expect(body.unreadCount).toBe(0);
    expect(body.partialErrors).toHaveLength(1);
    expect(body.partialErrors[0]!.source).toBe("notification-service");
  });

  it("[case9] all sources failing -> 200 with both partialErrors", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding(validSession()).fetcher, SVC_EVENT: failingBinding("throw"), SVC_NOTIFICATION: failingBinding("throw") });
    const res = await app().fetch(new Request("https://x/api/v1/bff/home", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gateway.BffHomeResponse;
    expect(body.partialErrors.map((e) => e.source).sort()).toEqual(["event-service", "notification-service"]);
  });

  it("[case9] unauthenticated -> 401 whole-request error", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding({ valid: false, userId: null, session: null, reason: "expired" }).fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/bff/home", { headers: { authorization: "Bearer bad" } }), env, execCtx);
    expect(res.status).toBe(401);
  });
});
