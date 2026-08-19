import { describe, it, expect, vi } from "vitest";
import { probeBinding } from "../src/checks";
import { sweepAssets } from "../src/frontend";

function res(status: number, body = "", contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

/** Build a stub Fetcher that answers by pathname (and optionally method). */
function stubFetcher(answer: (path: string, method: string) => Response) {
  return {
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      return answer(url.pathname, req.method);
    }),
  } as never;
}

describe("probeBinding", () => {
  it("down (never throws) when the binding is unbound", async () => {
    const out = await probeBinding(undefined, "/health");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("not bound");
  });

  it("ok on a 200 from the bound service", async () => {
    const out = await probeBinding(stubFetcher(() => res(200, `{"status":"ok"}`, "application/json")), "/health");
    expect(out.ok).toBe(true);
  });

  it("down on a non-200 from the bound service", async () => {
    const out = await probeBinding(stubFetcher(() => res(503)), "/internal/health");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("HTTP 503");
  });

  it("attaches x-dub-request-id + caller + internal (so allowGenerate:false services accept it)", async () => {
    const seen: Record<string, string> = {};
    const fetcher = {
      fetch: vi.fn(async (req: Request) => {
        req.headers.forEach((v, k) => (seen[k] = v));
        return res(200);
      }),
    } as never;
    await probeBinding(fetcher, "/health");
    expect(seen["x-dub-request-id"]).toBeTruthy();
    expect(seen["x-dub-caller"]).toBe("app-health-monitor");
    expect(seen["x-dub-internal"]).toBe("1");
  });

  it("enforces a body marker when requested (SPA served an error page => down)", async () => {
    const out = await probeBinding(stubFetcher(() => res(200, "something went wrong", "text/html")), "/mail", { bodyIncludes: `id="root"` });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("missing marker");
  });
});

describe("sweepAssets — stale/missing chunk detection (over SVC_FE binding)", () => {
  it("passes when every listed chunk resolves 200", async () => {
    const fe = stubFetcher((path) => {
      if (path === "/app-health.json") return res(200, JSON.stringify({ assets: ["/assets/a.js", "/assets/b.css"] }), "application/json");
      return res(200);
    });
    const out = await sweepAssets(fe);
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("all 2 chunks present");
  });

  it("fails and names the missing chunk (the incident)", async () => {
    const fe = stubFetcher((path) => {
      if (path === "/app-health.json") return res(200, JSON.stringify({ assets: ["/assets/a.js", "/assets/stale.js"] }), "application/json");
      if (path === "/assets/stale.js") return res(404);
      return res(200);
    });
    const out = await sweepAssets(fe);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("chunk(s) missing");
    expect(out.detail).toContain("stale.js");
  });

  it("fails when the manifest itself is missing (deploy didn't ship it)", async () => {
    const out = await sweepAssets(stubFetcher(() => res(404)));
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("app-health.json HTTP 404");
  });
});
