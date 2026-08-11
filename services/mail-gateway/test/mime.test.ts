import { describe, it, expect } from "vitest";
import {
  assembleMime,
  b64encodeUtf8,
  decodeHeaderWord,
  decodeQuotedPrintable,
  encodeHeaderWord,
  extractBody,
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

  it("decodes a quoted-printable snippet (no =XX artifacts)", () => {
    const raw =
      "Content-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
      "Marker=3D42 soft=\r\nwrap";
    expect(extractSnippet(raw)).toBe("Marker=42 softwrap");
  });
});

describe("decodeQuotedPrintable", () => {
  it("removes soft line breaks and decodes =XX", () => {
    expect(decodeQuotedPrintable("a=3Db soft=\r\nwrap")).toBe("a=b softwrap");
  });

  it("decodes UTF-8 multi-byte sequences", () => {
    // "会" = E4 BC 9A in UTF-8
    expect(decodeQuotedPrintable("=E4=BC=9A", "utf-8")).toBe("会");
  });
});

describe("extractBody (MIME transfer decode)", () => {
  it("decodes a quoted-printable single part", () => {
    const raw =
      "Content-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
      "Post-migration test. Marker=3D1786478801. Path =\r\nOK.";
    expect(extractBody(raw)).toBe("Post-migration test. Marker=1786478801. Path OK.");
  });

  it("decodes a base64 single part (Japanese)", () => {
    const body = "議事録\n二行目";
    const raw =
      "Content-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      b64encodeUtf8(body);
    expect(extractBody(raw)).toBe(body);
  });

  it("prefers the text/plain part of multipart/alternative", () => {
    const boundary = "b0undary";
    const raw =
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
      "plain =E4=BD=93 body\r\n" + // 体
      `--${boundary}\r\n` +
      "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
      "<p>html body</p>\r\n" +
      `--${boundary}--\r\n`;
    expect(extractBody(raw)).toBe("plain 体 body");
  });

  it("falls back to HTML (tags stripped) when no text/plain part exists", () => {
    const boundary = "hb";
    const raw =
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
      "<div>Hello<br><b>World</b></div>\r\n" +
      `--${boundary}--\r\n`;
    expect(extractBody(raw)).toBe("Hello\nWorld");
  });

  it("keeps a plain unencoded body intact", () => {
    const raw = "Subject: x\r\nFrom: a@x.com\r\n\r\nLine one\r\nLine two";
    expect(extractBody(raw)).toBe("Line one\nLine two");
  });
});
