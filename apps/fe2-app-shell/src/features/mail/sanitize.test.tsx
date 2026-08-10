// sanitizeHtml — the allowlist sanitizer that guards rendering of untrusted inbound
// mail bodies. These assert the dangerous surfaces are neutralized while safe
// formatting survives.
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize.tsx";

describe("sanitizeHtml", () => {
  it("keeps allowlisted formatting tags", () => {
    const out = sanitizeHtml("<p>Hello <strong>world</strong> and <em>friends</em></p>");
    expect(out).toContain("<strong>world</strong>");
    expect(out).toContain("<em>friends</em>");
    expect(out).toContain("<p>");
  });

  it("drops <script> entirely (tag and contents)", () => {
    const out = sanitizeHtml('<div>ok<script>alert(1)</script></div>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("ok");
  });

  it("strips inline event handlers and style/class/id attributes", () => {
    const out = sanitizeHtml('<p onclick="steal()" style="color:red" class="x" id="y">hi</p>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("style");
    expect(out).not.toContain("class");
    expect(out).not.toContain("id=");
    expect(out).toContain("hi");
  });

  it("rejects javascript: URLs on links but keeps http/mailto", () => {
    const bad = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(bad).not.toContain("javascript:");
    const good = sanitizeHtml('<a href="https://example.com">x</a>');
    expect(good).toContain('href="https://example.com"');
    expect(good).toContain('rel="noopener noreferrer"');
    expect(good).toContain('target="_blank"');
    const mail = sanitizeHtml('<a href="mailto:a@b.com">x</a>');
    expect(mail).toContain('href="mailto:a@b.com"');
  });

  it("rejects data: image sources", () => {
    const out = sanitizeHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="a">');
    expect(out).not.toContain("data:");
    expect(out).not.toContain("onload");
  });

  it("unwraps unknown tags but preserves their text content", () => {
    const out = sanitizeHtml("<marquee>keep <b>me</b></marquee>");
    expect(out).not.toContain("marquee");
    expect(out).toContain("keep");
    expect(out).toContain("<b>me</b>");
  });

  it("removes HTML comments", () => {
    const out = sanitizeHtml("<p>a<!-- secret -->b</p>");
    expect(out).not.toContain("secret");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });
});
