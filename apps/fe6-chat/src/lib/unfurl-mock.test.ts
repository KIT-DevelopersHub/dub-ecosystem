import { describe, it, expect } from "vitest";
import { mockUnfurl, UNFURL_GENERIC_MARKER } from "./unfurl-mock";

describe("mockUnfurl (backend-free demo)", () => {
  it("returns a hand-tuned card for a known host (subdomains included)", () => {
    const p = mockUnfurl("https://github.com/KIT-DevelopersHub/dub-ecosystem");
    expect(p).not.toBeNull();
    expect(p!.siteName).toBe("GitHub");
    expect(p!.title).toContain("dub-ecosystem");
    expect(p!.imageUrl).toMatch(/^data:image\/svg\+xml/);
  });

  it("returns a GENERIC card for an unknown host (the fix)", () => {
    const p = mockUnfurl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(p).not.toBeNull();
    expect(p!.siteName).toBe("youtube.com"); // hostname, www. stripped
    expect(p!.title).toBe("watch"); // last path segment, cleaned
    expect(p!.description).toContain("youtube.com");
    expect(p!.imageUrl).toMatch(/^data:image\/svg\+xml/); // inline SVG, no network
    expect(p!.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("is deterministic: same URL -> identical card", () => {
    const url = "https://news.example.org/2026/story-title";
    expect(mockUnfurl(url)).toEqual(mockUnfurl(url));
  });

  it("falls back to the site name as title when the path is empty", () => {
    const p = mockUnfurl("https://some-blog.dev/");
    expect(p!.title).toBe("some-blog.dev");
  });

  it("returns null for non-http(s) schemes (URL-only, no card)", () => {
    expect(mockUnfurl("mailto:a@b.com")).toBeNull();
    expect(mockUnfurl("ftp://host/file")).toBeNull();
    expect(mockUnfurl("javascript:alert(1)")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(mockUnfurl("not a url")).toBeNull();
    expect(mockUnfurl("")).toBeNull();
  });

  it("exports a liveness marker string", () => {
    expect(UNFURL_GENERIC_MARKER).toBe("fe6-unfurl-generic-v2");
  });
});
