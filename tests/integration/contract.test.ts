// Contract-conformance tests (integration-e2e §7 契約適合 C-series). Verifies the
// wire contracts every service must honour: error envelope (@dub/errors), the
// x-dub-request-id correlation header, the canonical Queue event envelope
// (@dub/events), rate-limit shape, and BFF partial-error degradation.
import { describe, it, expect } from "vitest";
import { createHarness } from "../lib/harness";
import { createEvent, publishEvent, type DubEventPublisherEnv } from "@dub/events";
import type { ErrorResponse } from "@dub/errors";
import type { gateway } from "@dub/types";
import type { Queue } from "@cloudflare/workers-types";

const REQUIRED_ENVELOPE_FIELDS = ["name", "version", "id", "occurredAt", "requestId", "actorId", "payload"] as const;

function isErrorResponse(raw: unknown): raw is ErrorResponse {
  const e = (raw as ErrorResponse | undefined)?.error;
  return !!e && typeof e.code === "string" && typeof e.message === "string" && typeof e.retryable === "boolean";
}

describe("C2 every 4xx/5xx is @dub/errors ErrorResponse with the right code", () => {
  it("401 UNAUTHENTICATED / 403 FORBIDDEN / 404 NOT_FOUND / 400 VALIDATION_FAILED", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const outsider = await h.login("outsider");

    const cases: { res: Awaited<ReturnType<typeof h.gw>>; code: string; status: number }[] = [
      { res: await h.gw("GET", "/api/v1/events"), code: "UNAUTHENTICATED", status: 401 },
      { res: await h.gw("GET", "/api/v1/events", { token: outsider }), code: "FORBIDDEN", status: 403 },
      { res: await h.gw("GET", "/api/v1/tasks/task_does_not_exist", { token: admin }), code: "NOT_FOUND", status: 404 },
      { res: await h.gw("POST", "/api/v1/events", { token: admin, body: { title: "" } }), code: "VALIDATION_FAILED", status: 400 },
    ];
    for (const c of cases) {
      expect(c.res.status).toBe(c.status);
      expect(isErrorResponse(c.res.raw)).toBe(true);
      expect((c.res.raw as ErrorResponse).error.code).toBe(c.code);
    }
  });

  it("gateway-owned 404 for an unknown segment is also ErrorResponse", async () => {
    const h = await createHarness();
    const admin = await h.login("admin");
    const res = await h.gw("GET", "/api/v1/nonesuch/thing", { token: admin });
    expect(res.status).toBe(404);
    expect(isErrorResponse(res.raw)).toBe(true);
  });
});

describe("C3 x-dub-request-id correlation header", () => {
  it("is present on success and error responses, and inherited when supplied", async () => {
    const h = await createHarness();
    const token = await h.login("organizer");

    const ok = await h.gw("GET", "/api/v1/events", { token });
    expect(ok.requestId).toBeTruthy();

    const err = await h.gw("GET", "/api/v1/events");
    expect(err.requestId).toBeTruthy();

    const supplied = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const inherited = await h.gw("GET", "/api/v1/events", { token, headers: { "x-dub-request-id": supplied } });
    expect(inherited.requestId).toBe(supplied);
  });
});

describe("C4 canonical Queue event envelope (@dub/events)", () => {
  it("createEvent yields all 7 required fields with requestId as the correlation key", () => {
    const env = createEvent(
      "task.assigned",
      { taskId: "task_1", eventId: "event_1", assigneeId: "usr_1", title: "t" } as never,
      { requestId: "req_1", actorId: "usr_actor" },
    );
    for (const f of REQUIRED_ENVELOPE_FIELDS) expect(env).toHaveProperty(f);
    expect(env.name).toBe("task.assigned");
    expect(env.version).toBe(1);
    expect(env.requestId).toBe("req_1");
    expect(env.actorId).toBe("usr_actor");
  });

  it("publishEvent fans out to every subscriber queue named in SUBSCRIPTIONS", async () => {
    const sent: Record<string, unknown[]> = {};
    const mkQ = (name: string): Queue =>
      ({ send: async (m: unknown) => void (sent[name] ??= []).push(m), sendBatch: async () => {} }) as unknown as Queue;
    // task.assigned -> [notification, github-sync, gantt, mobile-bff]
    const publisherEnv: DubEventPublisherEnv = {
      EVT_NOTIFICATION: mkQ("notification"),
      EVT_GITHUB_SYNC: mkQ("github-sync"),
      EVT_GANTT: mkQ("gantt"),
      EVT_MOBILE_BFF: mkQ("mobile-bff"),
    };
    const env = createEvent(
      "task.assigned",
      { taskId: "t", eventId: "e", assigneeId: "u", title: "x" } as never,
      { requestId: "r", actorId: null },
    );
    await publishEvent(publisherEnv, env);
    expect(Object.keys(sent).sort()).toEqual(["gantt", "github-sync", "mobile-bff", "notification"]);
  });

  it("archived events use the *.archived name (theme1: *.deleted retired)", () => {
    const env = createEvent("event.archived", { eventId: "e" } as never, { requestId: "r", actorId: null });
    expect(env.name).toBe("event.archived");
    expect(env.name.endsWith(".archived")).toBe(true);
  });
});

describe("C6 rate limit: 429 + RateLimit-* headers (contract shape only)", () => {
  it("a denying limiter yields 429 with ratelimit headers, not a plain error", async () => {
    const denying = {
      check: async () => ({ allowed: false, limit: 100, remaining: 0, retryAfterSec: 30, resetEpochSec: 9_999_999_999 }),
    };
    const h = await createHarness({ rateLimiter: denying });
    const res = await h.gw("GET", "/api/v1/events", { token: "anything" });
    expect(res.status).toBe(429);
    expect(res.headers.get("ratelimit-limit")).toBe("100");
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
    expect(res.requestId).toBeTruthy();
  });
});

describe("C8 BFF /bff/home degrades a failed source to 200 + partialErrors (theme10 A6)", () => {
  it("with notification down, home still returns 200 and reports the source", async () => {
    const h = await createHarness({ breakNotification: true });
    const token = await h.login("organizer");
    const home = await h.gw("GET", "/api/v1/bff/home", { token });
    expect(home.status).toBe(200);
    const body = home.json<gateway.BffHomeResponse>();
    expect(body.partialErrors.length).toBeGreaterThan(0);
    expect(body.partialErrors.map((p) => p.source)).toContain("notification-service");
    // the healthy source (events) is still populated
    expect(Array.isArray(body.upcomingEvents)).toBe(true);
  });
});
