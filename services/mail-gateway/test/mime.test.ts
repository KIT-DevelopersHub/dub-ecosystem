import { describe, it, expect } from "vitest";
import {
  assembleMime,
  decodeHeaderWord,
  encodeHeaderWord,
  extractSnippet,
  formatAddress,
  parseAddress,
  parseAddressList,
} from "../src/mime";

describe("RFC2047 header words", () => {
  it("leaves ASCII subjects untouched", () => {
    expect(encodeHeaderWord("Hello world")).toBe("Hello world");
  });

  it("round-trips a Japanese subject (B-encoding)", () => {
    const subject = "会議の議事録 2026";
    const encoded = encodeHeaderWord(subject);
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    expect(decodeHeaderWord(encoded)).toBe(subject);
  });

  it("decodes Q-encoded words", () => {
    // "=?UTF-8?Q?a_b?=" -> "a b"
    expect(decodeHeaderWord("=?UTF-8?Q?a_b?=")).toBe("a b");
  });
});

describe("address parsing", () => {
  it("parses name + email", () => {
    expect(parseAddress("Alice <alice@example.com>")).toEqual({ email: "alice@example.com", name: "Alice" });
  });
  it("parses a bare email", () => {
    expect(parseAddress("bob@example.com")).toEqual({ email: "bob@example.com" });
  });
  it("decodes an RFC2047-encoded display name", () => {
    const raw = `${encodeHeaderWord("高岡")} <t@example.com>`;
    expect(parseAddress(raw)).toEqual({ email: "t@example.com", name: "高岡" });
  });
  it("splits a comma-separated list, respecting quotes", () => {
    const list = parseAddressList('"Doe, John" <john@x.com>, jane@y.com');
    expect(list).toEqual([{ email: "john@x.com", name: "Doe, John" }, { email: "jane@y.com" }]);
  });
  it("formats back with encoding", () => {
    expect(formatAddress({ email: "a@x.com", name: "Al" })).toBe("Al <a@x.com>");
    expect(formatAddress({ email: "a@x.com" })).toBe("a@x.com");
  });
});

describe("assembleMime", () => {
  it("builds a text-only message with headers", () => {
    const mime = assembleMime({
      from: "info@developershub.jp",
      to: [{ email: "a@x.com" }],
      cc: [],
      subject: "Hi",
      textBody: "body text",
      htmlBody: null,
      messageId: "mid1",
      inReplyTo: null,
    });
    expect(mime).toContain("From: info@developershub.jp");
    expect(mime).toContain("To: a@x.com");
    expect(mime).toContain("Message-ID: <mid1>");
    expect(mime).toContain("text/plain");
    expect(mime).not.toContain("multipart/alternative");
  });

  it("builds a multipart/alternative message when htmlBody is present, with In-Reply-To/References", () => {
    const mime = assembleMime({
      from: "info@developershub.jp",
      to: [{ email: "a@x.com" }],
      cc: [{ email: "c@x.com" }],
      subject: "件名",
      textBody: "text",
      htmlBody: "<b>html</b>",
      messageId: "mid2",
      inReplyTo: "orig@x.com",
      loopHeaders: { "auto-submitted": "auto-replied", "x-dub-mail-loop": "1" },
    });
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
    expect(mime).toContain("In-Reply-To: <orig@x.com>");
    expect(mime).toContain("References: <orig@x.com>");
    expect(mime).toContain("Auto-Submitted: auto-replied");
    expect(mime).toContain("X-Dub-Mail-Loop: 1");
    expect(mime).toContain("Cc: c@x.com");
    expect(mime).toContain("=?UTF-8?B?"); // encoded subject
  });
});

describe("extractSnippet", () => {
  it("takes body text after the header separator", () => {
    const raw = "Subject: x\r\nFrom: a@x.com\r\n\r\nThis is the body.\r\nSecond line.";
    expect(extractSnippet(raw)).toBe("This is the body. Second line.");
  });
});
