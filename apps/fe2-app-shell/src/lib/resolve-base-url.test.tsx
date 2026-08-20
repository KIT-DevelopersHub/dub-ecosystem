import { describe, it, expect, vi } from "vitest";
import { resolveBaseUrl, GATEWAY_FALLBACK, NXDOMAIN_HOST } from "./resolve-base-url.tsx";

describe("resolveBaseUrl", () => {
  it("falls back to the workers.dev gateway when unset", () => {
    expect(resolveBaseUrl(undefined)).toBe(GATEWAY_FALLBACK);
    expect(resolveBaseUrl("")).toBe(GATEWAY_FALLBACK);
    expect(resolveBaseUrl("   ")).toBe(GATEWAY_FALLBACK);
  });

  it("rejects the known-NXDOMAIN custom domain (the prod incident) and warns", () => {
    const warn = vi.fn();
    expect(resolveBaseUrl(`https://${NXDOMAIN_HOST}`, warn)).toBe(GATEWAY_FALLBACK);
    expect(resolveBaseUrl(`https://${NXDOMAIN_HOST}/api/v1`, warn)).toBe(GATEWAY_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("falls back (and warns) on an unparseable value", () => {
    const warn = vi.fn();
    expect(resolveBaseUrl("not a url", warn)).toBe(GATEWAY_FALLBACK);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("passes through a valid, resolvable custom base verbatim", () => {
    expect(resolveBaseUrl("https://dub-api-gateway.developershub-site.workers.dev")).toBe(
      "https://dub-api-gateway.developershub-site.workers.dev",
    );
    expect(resolveBaseUrl("https://gateway.example.com")).toBe("https://gateway.example.com");
  });
});
