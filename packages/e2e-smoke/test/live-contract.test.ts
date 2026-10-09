// Offline tests for the read-only live smoke (scripts/smoke-readonly.ts): the schemas come
// from the real gateway spec, and a stubbed fetch proves both that the deployed shapes
// pass and that a regression (anonymous 200, envelope drift, unknown keyword) fails.
import { describe, it, expect } from "vitest";

import { LIVE_CHECKS, loadSpec, responseSchema, runLiveChecks, validate } from "../src/live-contract";

const spec = loadSpec();

/** Shapes the gateway actually returns (handlers/healthz.ts, @dub/errors toErrorResponse). */
function deployedLike(url: URL): Response {
  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok", version: "abc123", requestId: "req_1" });
  }
  return Response.json(
    { error: { code: "UNAUTHENTICATED", message: "missing bearer/cookie token", retryable: false, requestId: "req_1" } },
    { status: 401 },
  );
}

const stub = (fn: (url: URL, init?: RequestInit) => Response) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => fn(new URL(String(input)), init)) as typeof fetch;

describe("live contract (offline)", () => {
  it("every check resolves a response schema from docs/openapi/api-gateway.yaml", () => {
    for (const c of LIVE_CHECKS) expect(responseSchema(spec, c.op, c.status)).toBeTruthy();
  });

  it("passes against the shapes the gateway returns today, using GET only", async () => {
    const methods = new Set<string>();
    const results = await runLiveChecks(
      "https://gw.test",
      spec,
      stub((url, init) => {
        methods.add(init?.method ?? "GET");
        expect(init?.body).toBeUndefined();
        return deployedLike(url);
      }),
    );
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect([...methods]).toEqual(["GET"]);
  });

  it("fails when a protected segment answers anonymously", async () => {
    const results = await runLiveChecks(
      "https://gw.test",
      spec,
      stub((url) => (url.pathname === "/api/v1/members/teams" ? Response.json({ teams: [] }) : deployedLike(url))),
    );
    const bad = results.find((r) => r.check.path === "/api/v1/members/teams")!;
    expect(bad.ok).toBe(false);
    expect(bad.problems).toContain("status 200, want 401");
  });

  it("fails when the error envelope drifts from the spec", async () => {
    const results = await runLiveChecks(
      "https://gw.test",
      spec,
      stub((url) =>
        url.pathname === "/healthz" ? deployedLike(url) : Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
      ),
    );
    expect(results.find((r) => r.check.path === "/api/v1/me")!.problems).toEqual(
      expect.arrayContaining(["$.error.message: required", "$.error.retryable: required"]),
    );
  });

  it("retries a transient 5xx, but never retries a 4xx answer", async () => {
    const hits = new Map<string, number>();
    const results = await runLiveChecks(
      "https://gw.test",
      spec,
      stub((url) => {
        const n = (hits.get(url.pathname) ?? 0) + 1;
        hits.set(url.pathname, n);
        return url.pathname === "/healthz" && n === 1 ? new Response("", { status: 503 }) : deployedLike(url);
      }),
      0,
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(hits.get("/healthz")).toBe(2);
    expect(hits.get("/api/v1/me")).toBe(1);
  });

  it("refuses schema keywords it does not implement instead of ignoring them", () => {
    expect(() => validate(spec, { oneOf: [{ type: "string" }] }, "x")).toThrow(/unsupported schema keyword "oneOf"/);
  });
});
