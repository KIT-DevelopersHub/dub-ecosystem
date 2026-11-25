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

describe("sanitizeHtml mail mode", () => {
  const mailHtml = (html: string, remoteImages = false): string => sanitizeHtml(html, { remoteImages });

  it("keeps layout attributes and drops everything else", () => {
    const out = mailHtml(`<table width="100%" onclick="x()" background="https://t/x.gif"><tr><td align="center" colspan="2" data-x="1">a</td></tr></table>`);
    expect(out).toContain('width="100%"');
    expect(out).toContain('align="center"');
    expect(out).toContain('colspan="2"');
    expect(out).not.toMatch(/onclick|background=|data-x/);
  });

  it("filters style declarations by property and by value", () => {
    const out = mailHtml(`<p style="color: red; position: fixed; top: 0; z-index: 9; background: url(https://t/x.gif); background-color: url(x); margin: -100px; margin-top: 4px; width: expression(alert(1))">a</p>`);
    expect(out).toBe('<p style="color: red; margin-top: 4px">a</p>');
  });

  it("removes the style attribute when nothing survives", () => {
    expect(mailHtml(`<p style="position: fixed">a</p>`)).toBe("<p>a</p>");
  });

  it("parks images: remote behind the switch, cid for its attachment, others gone", () => {
    expect(mailHtml(`<img src="https://t/p.gif">`)).toBe('<img data-src="https://t/p.gif">');
    expect(mailHtml(`<img src="https://t/p.gif">`, true)).toBe('<img src="https://t/p.gif">');
    expect(mailHtml(`<img src="cid:a@b">`)).toBe('<img data-cid="a@b">');
    expect(mailHtml(`<img src="data:image/png;base64,AAAA">`)).toBe("<img>");
    expect(mailHtml(`<img src="javascript:alert(1)">`)).toBe("<img>");
  });

  it("the default mode is unchanged", () => {
    expect(sanitizeHtml(`<p style="color: red">a</p>`)).toBe("<p>a</p>");
  });
});
