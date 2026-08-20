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
const tasksOk = () =>
  fakeBinding(() =>
    json(200, {
      items: [
        { id: "t1", status: "done" },
        { id: "t2", status: "done" },
        { id: "t3", status: "in_progress" },
        { id: "t4", status: "todo" },
        { id: "t5", status: "cancelled" },
      ],
      nextCursor: null,
    }),
  );
const usageOk = () =>
  fakeBinding(() =>
    json(200, {
      generatedAt: "2026-09-01T00:00:00Z",
      worstStatus: "warn",
      services: [
        { metricKey: "kv_reads_day", label: "KV 読み取り(日)", pct: 82.0 },
        { metricKey: "emails_month", label: "メール送信(月)", pct: 20.0 },
        { metricKey: "not_on_home", label: "隠れ指標", pct: 99.0 },
      ],
    }),
  );
const membersOk = () =>
  fakeBinding(() =>
    json(200, { teams: [{ id: "tm1" }, { id: "tm2" }], members: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
  );

describe("GET /api/v1/bff/home", () => {
  it("[case9] all sources succeed -> full DTO, empty partialErrors", async () => {
    const env = makeEnv({
      SVC_AUTH: authBinding(validSession()).fetcher,
      SVC_EVENT: eventsOk().fetcher,
      SVC_NOTIFICATION: unreadOk().fetcher,
      SVC_TASK: tasksOk().fetcher,
      SVC_USAGE_METER: usageOk().fetcher,
      SVC_MEMBER: membersOk().fetcher,
    });
    const res = await app().fetch(new Request("https://x/api/v1/bff/home", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gateway.BffHomeResponse;
    expect(body.upcomingEvents).toHaveLength(1);
    expect(body.unreadCount).toBe(7);
    // task breakdown bucketed by status (incl. cancelled in total).
    expect(body.taskSummary).toEqual({
      total: 5,
      byStatus: { todo: 1, in_progress: 1, blocked: 0, done: 2, cancelled: 1 },
    });
    // usage projected to the home allow-list only (the hidden 99% metric is dropped),
    // worst = most-stressed of the surfaced metrics.
    expect(body.usageSummary?.metrics.map((m) => m.key)).toEqual(["kv_reads_day", "emails_month"]);
    expect(body.usageSummary?.worst?.key).toBe("kv_reads_day");
    expect(body.orgStats).toEqual({ members: 3, teams: 2 });
    expect(body.partialErrors).toEqual([]);
  });

  it("[case9] a new-source failure (usage-meter) degrades to a partialErrors entry (200)", async () => {
    const env = makeEnv({
      SVC_AUTH: authBinding(validSession()).fetcher,
      SVC_EVENT: eventsOk().fetcher,
      SVC_NOTIFICATION: unreadOk().fetcher,
      SVC_TASK: tasksOk().fetcher,
      SVC_USAGE_METER: failingBinding("throw"),
      SVC_MEMBER: membersOk().fetcher,
    });
    const res = await app().fetch(new Request("https://x/api/v1/bff/home", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gateway.BffHomeResponse;
    expect(body.usageSummary).toBeUndefined();
    expect(body.taskSummary).toBeDefined();
    expect(body.orgStats).toBeDefined();
    expect(body.partialErrors.map((e) => e.source)).toContain("usage-meter");
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
