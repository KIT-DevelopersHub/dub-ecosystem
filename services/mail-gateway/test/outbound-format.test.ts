// Outbound wire format: RFC 2047 words, header folding, canonical CRLF body, boundaries,
// References chain (RFC 5322 §3.6.4) and the archive copy riding Bcc instead of Cc.
import { describe, it, expect, vi } from "vitest";
import {
  apiText,
  assembleMime,
  b64decodeToBytes,
  decodeHeaderWord,
  encodeHeaderWords,
  formatAddress,
  referencesHeader,
} from "../src/mime";
import { sendMail } from "../src/send";
import { ResendMailProvider } from "../src/resend";
import { SesMailProvider } from "../src/ses";
import type { OutboundMail } from "../src/provider";
import { makeHarness, sendDeps } from "./helpers";

const LONG_JA = "【重要】北陸ITカンファレンス2026 協賛のご案内と当日の進行スケジュールについてのご確認のお願い🙏";

function headerBlock(mime: string): string {
  return mime.slice(0, mime.indexOf("\r\n\r\n"));
}

describe("RFC 2047 encoded-words", () => {
  it("splits a long Japanese subject into <=75-char words on character boundaries", () => {
    const words = encodeHeaderWords(LONG_JA);
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      // Each word decodes on its own to valid UTF-8 (no split multi-byte char / surrogate).
      const text = w.slice("=?UTF-8?B?".length, -2);
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b64decodeToBytes(text));
      expect(decoded).not.toContain("�");
    }
    expect(decodeHeaderWord(words.join(" "))).toBe(LONG_JA);
    expect(decodeHeaderWord(words.join("\r\n "))).toBe(LONG_JA);
  });

  it("composes NFD input (macOS) to NFC before encoding", () => {
    const nfd = "ガイド".normalize("NFD");
    expect(decodeHeaderWord(encodeHeaderWords(nfd).join(" "))).toBe("ガイド");
  });

  it("decodes ISO-2022-JP words and drops whitespace between adjacent words (§6.2)", () => {
    expect(decodeHeaderWord("=?ISO-2022-JP?B?GyRCJUYlOSVIGyhC?=")).toBe("テスト");
    expect(decodeHeaderWord("=?UTF-8?B?5omT44Gh?= =?UTF-8?B?5ZCI44KP44Gb?=")).toBe("打ち合わせ");
    expect(decodeHeaderWord("Re: =?UTF-8?B?5omT44Gh?= x")).toBe("Re: 打ち x");
  });
});

describe("display names", () => {
  it("quotes ASCII names with specials, encodes non-ASCII ones outside quotes", () => {
    expect(formatAddress({ email: "j@x.com", name: "Doe, John" })).toBe('"Doe, John" <j@x.com>');
    expect(formatAddress({ email: "j@x.com", name: 'Say "hi"' })).toBe('"Say \\"hi\\"" <j@x.com>');
    const ja = formatAddress({ email: "t@x.com", name: "高岡 己太朗" });
    expect(ja).toMatch(/^=\?UTF-8\?B\?[^"]+\?= <t@x\.com>$/);
  });
});

describe("assembleMime wire format", () => {
  const base = {
    from: "info@developershub.jp",
    to: [{ email: "a@x.com", name: "山田 太郎" }],
    cc: [] as { email: string }[],
    subject: LONG_JA,
    textBody: "お世話になっております。\n\n> 引用行\n-- \n署名\r\nWindows行\r末尾",
    htmlBody: null,
    messageId: "maillog_01ABC@developershub.jp",
    inReplyTo: null,
    date: "Wed, 28 Oct 2026 09:00:00 +0000",
  };

  it("matches the golden text-only message", () => {
    expect(assembleMime(base)).toMatchSnapshot();
  });

  it("uses CRLF only, lines <=998 (headers <=78), folded subject, numeric Date zone", () => {
    const mime = assembleMime({ ...base, date: undefined });
    expect(mime.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of mime.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    for (const line of headerBlock(mime).split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(headerBlock(mime)).toMatch(/^Date: .* \+0000$/m);
    expect(headerBlock(mime)).toMatch(/^Content-Type: text\/plain; charset="UTF-8"$/m);
  });

  it("keeps the body's line structure (blank lines, quotes, signature) as canonical CRLF", () => {
    const mime = assembleMime(base);
    const b64 = mime.slice(mime.indexOf("\r\n\r\n") + 4).trim();
    const body = new TextDecoder().decode(b64decodeToBytes(b64));
    expect(body).toBe("お世話になっております。\r\n\r\n> 引用行\r\n-- \r\n署名\r\nWindows行\r\n末尾");
  });

  it("uses RFC 2046-legal boundaries (no '@' from the Message-ID)", () => {
    const mime = assembleMime({ ...base, htmlBody: "<p>x</p>" });
    const b = /boundary="([^"]+)"/.exec(mime)![1]!;
    expect(b).toMatch(/^[A-Za-z0-9_]+$/);
    expect(mime).toContain(`--${b}--`);
  });

  it("writes References = full chain (folded) and In-Reply-To = parent", () => {
    const mime = assembleMime({ ...base, inReplyTo: "p@x", references: ["root@x", "mid@x", "p@x"] });
    const head = headerBlock(mime).replace(/\r\n[ \t]+/g, " ");
    expect(head).toMatch(/^In-Reply-To: <p@x>$/m);
    expect(head).toMatch(/^References: <root@x> <mid@x> <p@x>$/m);
  });

  it("caps an overlong References chain to root + most recent ids", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}@x`);
    const refs = referencesHeader(ids)!.split("\r\n ");
    expect(refs).toHaveLength(20);
    expect(refs[0]).toBe("<m0@x>");
    expect(refs[19]).toBe("<m29@x>");
  });
});

describe("sendMail — archive copy and threading on the wire", () => {
  it("delivers archive@ via Bcc: absent from the visible Cc and the MIME headers", async () => {
    const h = makeHarness();
    await sendMail(sendDeps(h, { archiveCc: "archive@developershub.jp" }), { to: [{ email: "a@x.com" }], cc: [{ email: "boss@x.com" }], subject: "S", textBody: "b" }, "arch-1", "t");
    const out = h.provider.sent[0]!;
    expect(out.cc.map((a) => a.email)).toEqual(["boss@x.com"]);
    expect(out.bcc?.map((a) => a.email)).toEqual(["archive@developershub.jp"]);
    expect(headerBlock(out.mime)).not.toContain("archive@");
    expect(headerBlock(out.mime)).not.toMatch(/^bcc:/im);
  });

  it("keeps an archive address the caller CC'd explicitly visible", async () => {
    const h = makeHarness();
    await sendMail(sendDeps(h, { archiveCc: "archive@developershub.jp" }), { to: [{ email: "a@x.com" }], cc: [{ email: "archive@developershub.jp" }], subject: "S", textBody: "b" }, "arch-2", "t");
    const out = h.provider.sent[0]!;
    expect(out.cc.map((a) => a.email)).toEqual(["archive@developershub.jp"]);
    expect(out.bcc).toBeUndefined();
  });

  it("a reply to our own earlier send carries root + parent in References", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    const first = await sendMail(deps, { to: [{ email: "a@x.com" }], subject: "S", textBody: "1" }, "chain-1", "t");
    const second = await sendMail(deps, { to: [{ email: "a@x.com" }], subject: "Re: S", textBody: "2", inReplyTo: first.response.messageId }, "chain-2", "t");
    await sendMail(deps, { to: [{ email: "a@x.com" }], subject: "Re: S", textBody: "3", inReplyTo: second.response.messageId }, "chain-3", "t");
    expect(h.provider.sent[2]!.references).toEqual([first.response.messageId, second.response.messageId]);
  });
});

describe("JSON-API providers", () => {
  const msg = (over: Partial<OutboundMail> = {}): OutboundMail => ({
    from: "info@developershub.jp",
    to: [{ email: "j@x.com", name: "Doe, John" }],
    cc: [],
    bcc: [{ email: "archive@developershub.jp" }],
    subject: "件名",
    textBody: "a\r\nb\rc\nd",
    htmlBody: null,
    messageId: "m@developershub.jp",
    inReplyTo: "p@x",
    references: ["root@x", "p@x"],
    mime: "",
    ...over,
  });

  it("Resend: bcc, quoted names, LF-only text, single-line References chain", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "r1" }), { status: 200 }));
    await new ResendMailProvider({ apiKey: "k", fetchImpl }).send(msg());
    const p = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown> & { headers: Record<string, string> };
    expect(p.to).toEqual(['"Doe, John" <j@x.com>']);
    expect(p.bcc).toEqual(["archive@developershub.jp"]);
    expect(p.cc).toBeUndefined();
    expect(p.text).toBe(apiText("a\nb\nc\nd"));
    expect(p.headers.References).toBe("<root@x> <p@x>");
    expect(p.headers["In-Reply-To"]).toBe("<p@x>");
  });

  it("SES: Bcc goes to Destination.BccAddresses (raw MIME has no Bcc header)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ MessageId: "s1" }), { status: 200 }));
    await new SesMailProvider({ region: "ap-northeast-1", accessKeyId: "AK", secretAccessKey: "SK", fetchImpl }).send(msg());
    const p = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { Destination: { BccAddresses?: string[] } };
    expect(p.Destination.BccAddresses).toEqual(["archive@developershub.jp"]);
  });
});
