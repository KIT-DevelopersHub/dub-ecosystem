import { describe, it, expect, vi, afterEach } from "vitest";
import { probeHttp, probeBinding } from "../src/checks";
import { sweepAssets } from "../src/frontend";

afterEach(() => vi.unstubAllGlobals());

function res(status: number, body = "", contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("probeHttp", () => {
  it("ok on 200 with the expected body marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, `<div id="root"></div>`, "text/html")));
    const out = await probeHttp("https://x/", { bodyIncludes: `id="root"` });
    expect(out.ok).toBe(true);
  });

  it("down on wrong status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(500)));
    const out = await probeHttp("https://x/");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("HTTP 500");
  });

  it("down when the body marker is absent (SPA served an error page)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, `something went wrong`, "text/html")));
    const out = await probeHttp("https://x/", { bodyIncludes: `id="root"` });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("missing marker");
  });
});

describe("probeBinding", () => {
  it("down (never throws) when the binding is unbound", async () => {
    const out = await probeBinding(undefined, "/health");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("not bound");
  });

  it("ok on a 200 from the bound service", async () => {
    const fetcher = { fetch: vi.fn(async () => res(200, `{"status":"ok"}`, "application/json")) };
    const out = await probeBinding(fetcher as never, "/health");
    expect(out.ok).toBe(true);
  });

  it("down on a non-200 from the bound service", async () => {
    const fetcher = { fetch: vi.fn(async () => res(503)) };
    const out = await probeBinding(fetcher as never, "/internal/health");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("HTTP 503");
  });
});

describe("sweepAssets — stale/missing chunk detection", () => {
  it("passes when every listed chunk resolves 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/app-health.json")) return res(200, JSON.stringify({ assets: ["/assets/a.js", "/assets/b.css"] }), "application/json");
        return res(200);
      }),
    );
    const out = await sweepAssets("https://spa");
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("all 2 chunks present");
  });

  it("fails and names the missing chunk (the incident)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/app-health.json")) return res(200, JSON.stringify({ assets: ["/assets/a.js", "/assets/stale.js"] }), "application/json");
        if (url.endsWith("/assets/stale.js")) return res(404);
        return res(200);
      }),
    );
    const out = await sweepAssets("https://spa");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("chunk(s) missing");
    expect(out.detail).toContain("stale.js");
  });

  it("fails when the manifest itself is missing (deploy didn't ship it)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(404)));
    const out = await sweepAssets("https://spa");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("app-health.json HTTP 404");
  });
});
