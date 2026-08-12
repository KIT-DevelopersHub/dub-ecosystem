import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { assembleMime, extractAttachments, b64encodeUtf8 } from "../src/mime";
import { parseSendMailRequest } from "../src/validation";
import { sendMail } from "../src/send";
import { handleInbound } from "../src/inbound";
import { attachmentsFor, r2Blobs, type MailBlobStore } from "../src/attachments";
import { listAttachments } from "../src/repo";
import { makeHarness, sendDeps, inboundDeps } from "./helpers";
import type { RawInbound } from "../src/mime";

// ---- in-memory blob store (implements MailBlobStore) ----
function memBlobs(): MailBlobStore & { store: Map<string, { body: Uint8Array; contentType: string }> } {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    store,
    async put({ key, body, contentType }) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      store.set(key, { body: bytes, contentType });
    },
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return { body: v.body.buffer.slice(v.body.byteOffset, v.body.byteOffset + v.body.byteLength) as ArrayBuffer, contentType: v.contentType, size: v.body.byteLength };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const HELLO_B64 = b64encodeUtf8("hello attachment");

describe("assembleMime — attachments", () => {
  it("wraps the body + files in multipart/mixed with attachment disposition", () => {
    const mime = assembleMime({
      from: "info@developershub.jp",
      to: [{ email: "a@x.com" }],
      cc: [],
      subject: "hi",
      textBody: "body",
      htmlBody: null,
      messageId: "m1@developershub.jp",
      inReplyTo: null,
      attachments: [{ filename: "note.txt", contentType: "text/plain", contentBase64: HELLO_B64 }],
    });
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain('Content-Disposition: attachment; filename="note.txt"');
    expect(mime).toContain(HELLO_B64);
  });

  it("is byte-identical to the plain path when there are no attachments", () => {
    const base = {
      from: "info@developershub.jp",
      to: [{ email: "a@x.com" }],
      cc: [],
      subject: "hi",
      textBody: "body",
      htmlBody: null,
      messageId: "m2@developershub.jp",
      inReplyTo: null,
    };
    expect(assembleMime({ ...base, attachments: [] })).toBe(assembleMime(base));
    expect(assembleMime(base)).not.toContain("multipart/mixed");
  });
});

describe("extractAttachments — inbound MIME", () => {
  const boundary = "BOUND123";
  const rawFull =
    `From: sender@outside.com\r\n` +
    `To: info@developershub.jp\r\n` +
    `Subject: with file\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
    `See attached.\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/pdf; name="doc.pdf"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="doc.pdf"\r\n\r\n` +
    `${b64encodeUtf8("PDF-BYTES")}\r\n` +
    `--${boundary}--\r\n`;

  const limits = { maxCount: 10, maxBytesPerFile: 1_000_000, maxTotalBytes: 5_000_000 };

  it("pulls the attachment part (filename, type, bytes) and ignores the text part", () => {
    const atts = extractAttachments(rawFull, limits);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.filename).toBe("doc.pdf");
    expect(atts[0]!.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(atts[0]!.bytes)).toBe("PDF-BYTES");
  });

  it("returns [] for a plain non-multipart message", () => {
    expect(extractAttachments("Subject: x\r\n\r\njust text", limits)).toEqual([]);
  });

  it("respects the per-file size cap", () => {
    expect(extractAttachments(rawFull, { ...limits, maxBytesPerFile: 3 })).toEqual([]);
  });
});

describe("validation — attachments", () => {
  const base = { to: [{ email: "a@x.com" }], subject: "s", textBody: "b" };

  it("accepts a valid base64 attachment", () => {
    const req = parseSendMailRequest({ ...base, attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: HELLO_B64 }] });
    expect(req.attachments).toHaveLength(1);
  });

  it("rejects invalid base64", () => {
    expect(() => parseSendMailRequest({ ...base, attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "not base64!!!" }] })).toThrow();
  });

  it("rejects an oversized attachment", () => {
    const big = "A".repeat(Math.ceil((21 * 1024 * 1024 * 4) / 3)); // ~21MB decoded
    expect(() => parseSendMailRequest({ ...base, attachments: [{ filename: "big.bin", contentType: "application/octet-stream", contentBase64: big }] })).toThrow();
  });

  it("rejects too many attachments", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}.txt`, contentType: "text/plain", contentBase64: HELLO_B64 }));
    expect(() => parseSendMailRequest({ ...base, attachments: many })).toThrow();
  });
});

describe("sendMail — attachments persisted + handed to provider", () => {
  const req: mail.SendMailRequest = {
    to: [{ email: "a@x.com" }],
    subject: "hi",
    textBody: "body",
    attachments: [{ filename: "note.txt", contentType: "text/plain", contentBase64: HELLO_B64 }],
  };

  it("stores bytes in R2 + metadata in D1 and passes attachments to the provider", async () => {
    const h = makeHarness();
    const blobs = memBlobs();
    const deps = sendDeps(h, { blobs });
    const { status } = await sendMail(deps, req, "idem-att-1", "notification");
    expect(status).toBe("sent");

    // provider received the structured attachment
    expect(h.provider.sent[0]!.attachments).toHaveLength(1);
    expect(h.provider.sent[0]!.attachments![0]!.filename).toBe("note.txt");

    // metadata row + R2 object exist
    const sentRow = h.provider.sent[0]!.messageId.split("@")[0]!;
    const metas = await listAttachments(h.db, "sent", sentRow);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.filename).toBe("note.txt");
    expect(blobs.store.get(metas[0]!.r2_key)).toBeTruthy();
  });

  it("does not store attachments when no blob store is configured (send still succeeds)", async () => {
    const h = makeHarness();
    const deps = sendDeps(h); // no blobs
    const { status } = await sendMail(deps, req, "idem-att-2", "notification");
    expect(status).toBe("sent");
    const sentRow = h.provider.sent[0]!.messageId.split("@")[0]!;
    expect(await listAttachments(h.db, "sent", sentRow)).toHaveLength(0);
  });
});

describe("handleInbound — attachments", () => {
  const boundary = "IN-BOUND";
  function rawWithAttachment(): RawInbound {
    const rawFull =
      `Message-ID: <inbound-att@outside.com>\r\n` +
      `From: sender@outside.com\r\n` +
      `To: info@developershub.jp\r\n` +
      `Subject: has file\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
      `Body text\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/csv; name="data.csv"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="data.csv"\r\n\r\n` +
      `${b64encodeUtf8("a,b,c")}\r\n` +
      `--${boundary}--\r\n`;
    return {
      from: "sender@outside.com",
      to: "info@developershub.jp",
      headers: {
        "message-id": "<inbound-att@outside.com>",
        from: "sender@outside.com",
        to: "info@developershub.jp",
        subject: "has file",
        date: "Sat, 09 Aug 2026 05:00:00 +0000",
      },
      rawText: "Message-ID: <inbound-att@outside.com>\r\n\r\nBody text",
      rawSize: rawFull.length,
      rawFull,
    };
  }

  it("extracts + stores inbound attachments keyed to the message row", async () => {
    const h = makeHarness();
    const blobs = memBlobs();
    const deps = inboundDeps(h, { blobs });
    const { processed, message } = await handleInbound(deps, rawWithAttachment());
    expect(processed).toBe(true);

    const metas = await attachmentsFor(h.db, "inbound", message.id);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.filename).toBe("data.csv");
    expect(metas[0]!.contentType).toBe("text/csv");
    expect(blobs.store.size).toBe(1);
  });

  it("skips attachment extraction when no blob store is configured", async () => {
    const h = makeHarness();
    const deps = inboundDeps(h); // no blobs
    const { message } = await handleInbound(deps, rawWithAttachment());
    expect(await attachmentsFor(h.db, "inbound", message.id)).toHaveLength(0);
  });
});

describe("r2Blobs — wraps a bucket round-trip", () => {
  it("put then get returns the same bytes + content type", async () => {
    const bucket = new Map<string, { buf: ArrayBuffer; ct?: string }>();
    const store = r2Blobs({
      async put(key, body, opts) {
        bucket.set(key, { buf: body, ct: opts?.httpMetadata?.contentType });
      },
      async get(key) {
        const v = bucket.get(key);
        if (!v) return null;
        return { arrayBuffer: async () => v.buf, size: v.buf.byteLength, httpMetadata: { contentType: v.ct } };
      },
      async delete(key) {
        bucket.delete(key);
      },
    });
    const bytes = new TextEncoder().encode("payload");
    await store.put({ key: "k1", body: bytes, contentType: "text/plain" });
    const got = await store.get("k1");
    expect(got).toBeTruthy();
    expect(new TextDecoder().decode(got!.body)).toBe("payload");
    expect(got!.contentType).toBe("text/plain");
  });
});
