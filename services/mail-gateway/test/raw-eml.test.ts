import { describe, it, expect } from "vitest";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import handler from "../src/index";
import { handleInbound } from "../src/inbound";
import { rawEmlKey } from "../src/raw-eml";
import type { MailBlobStore } from "../src/attachments";
import type { RawInbound } from "../src/mime";
import { inboundDeps, makeEnv, makeHarness } from "./helpers";

function memBlobs(failPut = false): MailBlobStore & { store: Map<string, { body: Uint8Array; contentType: string }> } {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    store,
    async put({ key, body, contentType }) {
      if (failPut) throw new Error("r2 down");
      store.set(key, { body: body instanceof Uint8Array ? body : new Uint8Array(body), contentType });
    },
    async get(key) {
      const v = store.get(key);
      return v ? { body: v.body.slice().buffer, contentType: v.contentType, size: v.body.byteLength } : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function rawMsg(messageId: string, body = "hello"): RawInbound {
  const rawText = `Message-ID: <${messageId}>\r\nFrom: a@example.com\r\nTo: info@developershub.jp\r\nSubject: s\r\n\r\n${body}`;
  return {
    from: "a@example.com",
    to: "info@developershub.jp",
    headers: { "message-id": `<${messageId}>`, from: "a@example.com", to: "info@developershub.jp", subject: "s" },
    rawText,
    rawSize: rawText.length,
    rawFull: rawText,
    rawBytes: new TextEncoder().encode(rawText),
  };
}

const rawKeyOf = (raw: ReturnType<typeof makeHarness>["raw"], id: string) =>
  (raw.prepare(`SELECT raw_r2_key AS k FROM mail_inbound WHERE id = ?`).get(id) as { k: string | null }).k;

describe("raw .eml archive", () => {
  it("key is raw/<yyyy>/<mm>/<id>.eml (UTC)", () => {
    expect(rawEmlKey("mailin_1", new Date(Date.UTC(2026, 0, 31, 23, 0)))).toBe("raw/2026/01/mailin_1.eml");
  });

  it("stores the raw bytes in R2 and records the key on the row", async () => {
    const h = makeHarness();
    const blobs = memBlobs();
    const r = rawMsg("m1@x");
    const res = await handleInbound(inboundDeps(h, { blobs }), r);
    expect(res.processed).toBe(true);
    const key = rawKeyOf(h.raw, res.message.id);
    expect(key).toMatch(new RegExp(`^raw/\\d{4}/\\d{2}/${res.message.id}\\.eml$`));
    const stored = blobs.store.get(key!);
    expect(stored?.contentType).toBe("message/rfc822");
    expect(new TextDecoder().decode(stored!.body)).toBe(r.rawText);
  });

  it("an R2 failure never fails ingest (row stored, key NULL)", async () => {
    const h = makeHarness();
    const res = await handleInbound(inboundDeps(h, { blobs: memBlobs(true) }), rawMsg("m2@x"));
    expect(res.processed).toBe(true);
    expect(rawKeyOf(h.raw, res.message.id)).toBeNull();
    expect(h.mailAuto.sends).toHaveLength(1);
  });

  it("a redelivery does not write a second object", async () => {
    const h = makeHarness();
    const blobs = memBlobs();
    await handleInbound(inboundDeps(h, { blobs }), rawMsg("m3@x"));
    await handleInbound(inboundDeps(h, { blobs }), rawMsg("m3@x"));
    expect(blobs.store.size).toBe(1);
  });

  it("email() archives the WHOLE message, past the 64KB parse cap", async () => {
    const stored: { key: string; size: number }[] = [];
    const bucket = {
      async put(key: string, body: ArrayBuffer) {
        stored.push({ key, size: body.byteLength });
      },
      async get() {
        return null;
      },
      async delete() {},
    };
    const { env, raw } = makeEnv({ R2_MAIL: bucket as never });
    const text = `Message-ID: <big@x>\r\nFrom: a@example.com\r\nTo: info@developershub.jp\r\nSubject: big\r\n\r\n${"x".repeat(200 * 1024)}`;
    const bytes = new TextEncoder().encode(text);
    const msg = {
      from: "a@example.com",
      to: "info@developershub.jp",
      headers: new Headers({ "message-id": "<big@x>", from: "a@example.com", to: "info@developershub.jp", subject: "big" }),
      // delivered in 4KB chunks, like a real stream
      raw: new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.byteLength; i += 4096) c.enqueue(bytes.subarray(i, i + 4096));
          c.close();
        },
      }),
      rawSize: bytes.byteLength,
      async forward() {},
      setReject() {},
      async reply() {},
    } as unknown as ForwardableEmailMessage;
    await handler.email(msg, env);
    const eml = stored.find((s) => s.key.startsWith("raw/"));
    expect(eml?.size).toBe(bytes.byteLength);
    const row = raw.prepare(`SELECT raw_r2_key AS k FROM mail_inbound`).get() as { k: string };
    expect(row.k).toBe(eml?.key);
  });
});
