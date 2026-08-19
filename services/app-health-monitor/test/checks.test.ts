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

  it("content-type gate: a 200 text/html (SPA fallback) fails a javascript expectation", async () => {
    const out = await probeBinding(stubFetcher(() => res(200, "<!doctype html>", "text/html")), "/assets/x.js", {
      method: "HEAD",
      expectContentTypeIncludes: "javascript",
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("SPA-fallback => missing");
  });

  it("content-type gate: a real text/javascript chunk passes", async () => {
    const out = await probeBinding(stubFetcher(() => res(200, "", "text/javascript")), "/assets/x.js", {
      method: "HEAD",
      expectContentTypeIncludes: "javascript",
    });
    expect(out.ok).toBe(true);
  });
});

describe("sweepAssets — stale/missing chunk detection (over SVC_FE binding)", () => {
  // A present chunk answers with its real content-type (js/css); the SPA fallback answers 200
  // text/html for a MISSING chunk, so the stub returns js/css for known assets, html otherwise.
  const okAsset = (path: string) => (path.endsWith(".css") ? res(200, "", "text/css") : res(200, "", "text/javascript"));
  const spaFallback = () => res(200, "<!doctype html>", "text/html");

  it("prefers loadBearing and passes when every listed chunk serves its real type", async () => {
    const fe = stubFetcher((path) => {
      if (path === "/app-health.json")
        return res(200, JSON.stringify({ loadBearing: ["/assets/entry.js", "/assets/ChatApp.js"], assets: ["/assets/x.js"] }), "application/json");
      return okAsset(path);
    });
    const out = await sweepAssets(fe);
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("all 2 load-bearing chunks present");
  });

  it("falls back to assets when loadBearing is absent (older manifest)", async () => {
    const fe = stubFetcher((path) => {
      if (path === "/app-health.json") return res(200, JSON.stringify({ assets: ["/assets/a.js", "/assets/b.css"] }), "application/json");
      return okAsset(path);
    });
    expect((await sweepAssets(fe)).ok).toBe(true);
  });

  it("detects a missing chunk served as the SPA fallback (200 text/html) — the incident", async () => {
    const fe = stubFetcher((path) => {
      if (path === "/app-health.json") return res(200, JSON.stringify({ loadBearing: ["/assets/a.js", "/assets/stale.js"] }), "application/json");
      if (path === "/assets/stale.js") return spaFallback(); // missing -> index.html, NOT 404
      return okAsset(path);
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
