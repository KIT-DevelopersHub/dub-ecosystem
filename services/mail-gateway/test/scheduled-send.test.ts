import { describe, it, expect } from "vitest";
import type { common, mail } from "@dub/types";
import { createApp } from "../src/app";
import { runScheduledSendDrain } from "../src/scheduled-send";
import { MockMailProvider } from "../src/provider";
import { b64encodeUtf8 } from "../src/mime";
import { makeEnv } from "./helpers";
import type { Env } from "../src/env";

const app = createApp();
const USER = "usr_alice";

function h(over: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-dub-request-id": "req_sched", "x-dub-user-id": USER, ...over };
}
function req(env: Env, path: string, method: string, body?: unknown): Promise<Response> {
  // Hono's app.fetch is typed `Response | Promise<Response>`; normalise to a Promise so
  // this helper's declared return type holds regardless of the Hono version on main.
  return Promise.resolve(app.fetch(new Request(`https://svc${path}`, { method, headers: h(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env));
}

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const schedBody = (over: Partial<mail.ScheduleMailRequest> = {}): mail.ScheduleMailRequest => ({
  to: [{ email: "recipient@example.com" }],
  subject: "予約テスト",
  textBody: "これは予約送信の本文です。",
  scheduledAt: future(),
  ...over,
});

describe("POST /mail/scheduled", () => {
  it("401s without a trusted user header", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/scheduled", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(schedBody()) }), env);
    expect(res.status).toBe(401);
  });

  it("schedules a future send (202) and lists it under GET /mail/scheduled", async () => {
    const { env } = makeEnv();
    const created = await req(env, "/mail/scheduled", "POST", schedBody());
    expect(created.status).toBe(202);
    const ack = (await created.json()) as mail.ScheduleMailResponse;
    expect(ack.status).toBe("scheduled");
    expect(ack.id).toMatch(/^mailsch_/);

    const list = await req(env, "/mail/scheduled", "GET");
    const page = (await list.json()) as common.Paginated<mail.ScheduledSendListItem>;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.subject).toBe("予約テスト");
    expect(page.items[0]!.status).toBe("scheduled");
  });

  it("400s when scheduledAt is in the past", async () => {
    const { env } = makeEnv();
    const res = await req(env, "/mail/scheduled", "POST", schedBody({ scheduledAt: new Date(Date.now() - 1000).toISOString() }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MAIL_INVALID_REQUEST");
  });

  it("503s when a scheduled send carries attachments but R2 is not bound (same as /outbox)", async () => {
    const { env } = makeEnv();
    const res = await req(env, "/mail/scheduled", "POST", {
      ...schedBody(),
      attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" }],
    });
    expect(res.status).toBe(503);
    const list = (await (await req(env, "/mail/scheduled", "GET")).json()) as common.Paginated<mail.ScheduledSendListItem>;
    expect(list.items).toHaveLength(0);
  });
});

describe("scheduled-send drain", () => {
  it("delivers a due schedule: appears in Sent and flips the row to 'sent'", async () => {
    const { env, sends } = makeEnv();
    const created = await req(env, "/mail/scheduled", "POST", schedBody());
    const ack = (await created.json()) as mail.ScheduleMailResponse;

    // Not yet due -> nothing sent.
    const early = await runScheduledSendDrain(env, Date.now());
    expect(early.sent).toBe(0);

    // Past the due time -> delivered exactly once.
    const result = await runScheduledSendDrain(env, Date.now() + 2 * 60 * 60 * 1000);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);

    // Sent folder now shows it.
    const sent = await req(env, "/mail/sent", "GET");
    const sentPage = (await sent.json()) as common.Paginated<mail.MailSentListItem>;
    expect(sentPage.items.some((s) => s.subject === "予約テスト")).toBe(true);
    // Notification event fired for the real send.
    expect(sends.notif.some((e) => e.name === "mail.message.sent")).toBe(true);

    // Schedule row left the 'scheduled' list, and a second drain does not re-send.
    const list = await req(env, "/mail/scheduled", "GET");
    const page = (await list.json()) as common.Paginated<mail.ScheduledSendListItem>;
    expect(page.items).toHaveLength(0);
    const detail = await req(env, `/mail/scheduled/${ack.id}`, "GET");
    expect(((await detail.json()) as mail.ScheduledSendDetail).status).toBe("sent");
    const again = await runScheduledSendDrain(env, Date.now() + 3 * 60 * 60 * 1000);
    expect(again.sent).toBe(0);
  });

  it("does not deliver a canceled schedule", async () => {
    const { env } = makeEnv();
    const created = await req(env, "/mail/scheduled", "POST", schedBody());
    const ack = (await created.json()) as mail.ScheduleMailResponse;

    const del = await req(env, `/mail/scheduled/${ack.id}`, "DELETE");
    expect(del.status).toBe(200);

    const result = await runScheduledSendDrain(env, Date.now() + 2 * 60 * 60 * 1000);
    expect(result.sent).toBe(0);
    const sent = await req(env, "/mail/sent", "GET");
    const sentPage = (await sent.json()) as common.Paginated<mail.MailSentListItem>;
    expect(sentPage.items).toHaveLength(0);
  });

  it("edits/reschedules a still-'scheduled' send", async () => {
    const { env } = makeEnv();
    const created = await req(env, "/mail/scheduled", "POST", schedBody());
    const ack = (await created.json()) as mail.ScheduleMailResponse;

    const patched = await req(env, `/mail/scheduled/${ack.id}`, "PATCH", { subject: "件名変更", scheduledAt: future() });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as mail.ScheduledSendDetail).subject).toBe("件名変更");
  });

  it("409s when editing a send that already went out", async () => {
    const { env } = makeEnv();
    const created = await req(env, "/mail/scheduled", "POST", schedBody());
    const ack = (await created.json()) as mail.ScheduleMailResponse;
    await runScheduledSendDrain(env, Date.now() + 2 * 60 * 60 * 1000);
    const patched = await req(env, `/mail/scheduled/${ack.id}`, "PATCH", { subject: "遅い編集" });
    expect(patched.status).toBe(409);
  });
});

// ---- 0020: attachments + Bcc + reply threading on a scheduled send ----

/** In-memory R2 bucket (the subset r2Blobs() uses). */
function memR2(): { bucket: R2Bucket; store: Map<string, { body: ArrayBuffer; contentType?: string }> } {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  const bucket = {
    async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body: body.slice(0), ...(opts?.httpMetadata?.contentType ? { contentType: opts.httpMetadata.contentType } : {}) });
      return {};
    },
    async get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      return { arrayBuffer: async () => v.body.slice(0), size: v.body.byteLength, httpMetadata: { contentType: v.contentType } };
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOTE_B64 = b64encodeUtf8("予約送信の添付テキスト");
const later = (ms = 2 * 60 * 60 * 1000) => Date.now() + ms;

describe("scheduled send with attachments (0020)", () => {
  it("parks the files in R2, lists their metadata, and sends them at delivery", async () => {
    const r2 = memR2();
    const { env } = makeEnv({ R2_MAIL: r2.bucket });
    const created = await req(env, "/mail/scheduled", "POST", {
      ...schedBody({ subject: "添付つき予約" }),
      attachments: [
        { filename: "photo.png", contentType: "image/png", contentBase64: PNG_B64 },
        { filename: "note.txt", contentType: "text/plain", contentBase64: NOTE_B64 },
      ],
    });
    expect(created.status).toBe(202);
    const ack = (await created.json()) as mail.ScheduleMailResponse;

    // Parked: bytes under ORG/scheduled/<id>/..., metadata on list + detail.
    expect([...r2.store.keys()].filter((k) => k.includes(`/scheduled/${ack.id}/`))).toHaveLength(2);
    const list = (await (await req(env, "/mail/scheduled", "GET")).json()) as common.Paginated<mail.ScheduledSendListItem>;
    expect(list.items[0]!.attachments?.map((a) => a.filename)).toEqual(["photo.png", "note.txt"]);
    const detail = (await (await req(env, `/mail/scheduled/${ack.id}`, "GET")).json()) as mail.ScheduledSendDetail;
    expect(detail.attachments?.[0]).toMatchObject({ filename: "photo.png", contentType: "image/png", sizeBytes: 70 });

    const provider = new MockMailProvider();
    const result = await runScheduledSendDrain(env, later(), provider);
    expect(result.sent).toBe(1);

    // The provider got both files, byte-identical to what was scheduled.
    const out = provider.sent[0]!;
    expect(out.attachments?.map((a) => [a.filename, a.contentType, a.contentBase64])).toEqual([
      ["photo.png", "image/png", PNG_B64],
      ["note.txt", "text/plain", NOTE_B64],
    ]);
    expect(out.mime).toContain("multipart/mixed");
    expect(out.mime).toContain('filename="photo.png"');

    // Sent folder shows the attachments (stored by the send core), and they download.
    const sentPage = (await (await req(env, "/mail/sent", "GET")).json()) as common.Paginated<mail.MailSentListItem>;
    const sentId = sentPage.items[0]!.id;
    const sentDetail = (await (await req(env, `/mail/sent/${sentId}`, "GET")).json()) as mail.MailSentDetail;
    expect(sentDetail.attachments?.map((a) => a.filename).sort()).toEqual(["note.txt", "photo.png"]);
    const png = sentDetail.attachments!.find((a) => a.filename === "photo.png")!;
    const dl = await req(env, `/mail/sent/${sentId}/attachments/${png.id}`, "GET");
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer()).byteLength).toBe(70);

    // The parked copies are released once delivered; a second drain sends nothing.
    expect([...r2.store.keys()].filter((k) => k.includes("/scheduled/"))).toHaveLength(0);
    expect((await runScheduledSendDrain(env, later(3 * 60 * 60 * 1000), provider)).sent).toBe(0);
    expect(provider.sent).toHaveLength(1);
  });

  it("never sends file-less: a missing parked blob keeps the row scheduled for retry", async () => {
    const r2 = memR2();
    const { env } = makeEnv({ R2_MAIL: r2.bucket });
    const created = await req(env, "/mail/scheduled", "POST", {
      ...schedBody(),
      attachments: [{ filename: "photo.png", contentType: "image/png", contentBase64: PNG_B64 }],
    });
    const ack = (await created.json()) as mail.ScheduleMailResponse;
    r2.store.clear(); // simulate a lost blob

    const provider = new MockMailProvider();
    const result = await runScheduledSendDrain(env, later(), provider);
    expect(result).toMatchObject({ sent: 0, retried: 1 });
    expect(provider.sent).toHaveLength(0);
    const detail = (await (await req(env, `/mail/scheduled/${ack.id}`, "GET")).json()) as mail.ScheduledSendDetail;
    expect(detail.status).toBe("scheduled");
    expect(detail.errorCode).toBe("MAIL_ATTACHMENT_NOT_STORED");
  });

  it("rejects attachments over the same per-file limit as an immediate send", async () => {
    const { env } = makeEnv({ R2_MAIL: memR2().bucket });
    const res = await req(env, "/mail/scheduled", "POST", {
      ...schedBody(),
      attachments: [{ filename: "x.txt", contentType: "text/plain", contentBase64: "" }],
    });
    expect(res.status).toBe(400);
  });

  it("cancel releases the parked blobs", async () => {
    const r2 = memR2();
    const { env } = makeEnv({ R2_MAIL: r2.bucket });
    const created = await req(env, "/mail/scheduled", "POST", {
      ...schedBody(),
      attachments: [{ filename: "photo.png", contentType: "image/png", contentBase64: PNG_B64 }],
    });
    const ack = (await created.json()) as mail.ScheduleMailResponse;
    expect(r2.store.size).toBe(1);
    expect((await req(env, `/mail/scheduled/${ack.id}`, "DELETE")).status).toBe(200);
    expect(r2.store.size).toBe(0);
  });
});

describe("scheduled reply keeps threading + recipients (0020)", () => {
  it("delivers with In-Reply-To / References, the parent's thread id, To/Cc/Bcc", async () => {
    const r2 = memR2();
    const { env, raw } = makeEnv({ R2_MAIL: r2.bucket });
    const at = new Date().toISOString();
    raw.prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
       VALUES ('mailin_parent', 'parent-1@partner.example', 'thr_parent', ?, ?, 'ご相談', 'snip', ?, ?)`,
    ).run(JSON.stringify({ email: "partner@partner.example" }), JSON.stringify([{ email: "info@developershub.jp" }]), at, at);

    const created = await req(env, "/mail/scheduled", "POST", {
      ...schedBody({
        to: [{ email: "partner@partner.example" }],
        cc: [{ email: "cc-person@partner.example" }],
        bcc: [{ email: "boss@developershub.jp" }],
        subject: "Re: ご相談",
        textBody: "予約した返信です。",
        inReplyTo: "<parent-1@partner.example>",
      }),
      attachments: [{ filename: "photo.png", contentType: "image/png", contentBase64: PNG_B64 }],
    });
    expect(created.status).toBe(202);
    const ack = (await created.json()) as mail.ScheduleMailResponse;
    const detail = (await (await req(env, `/mail/scheduled/${ack.id}`, "GET")).json()) as mail.ScheduledSendDetail;
    expect(detail.inReplyTo).toBe("<parent-1@partner.example>");
    expect(detail.bcc).toEqual([{ email: "boss@developershub.jp" }]);
    expect(detail.from?.email).toBe("info@developershub.jp"); // replies as the mailbox it reached

    const provider = new MockMailProvider();
    expect((await runScheduledSendDrain(env, later(), provider)).sent).toBe(1);
    const out = provider.sent[0]!;
    expect(out.from).toBe("info@developershub.jp");
    expect(out.to.map((a) => a.email)).toEqual(["partner@partner.example"]);
    expect(out.cc.map((a) => a.email)).toEqual(["cc-person@partner.example"]);
    expect(out.bcc?.map((a) => a.email)).toContain("boss@developershub.jp");
    expect(out.inReplyTo).toBe("<parent-1@partner.example>");
    expect(out.references).toContain("parent-1@partner.example");
    const head = out.mime.slice(0, out.mime.search(/\r?\n\r?\n/));
    expect(head).toMatch(/^In-Reply-To: <parent-1@partner\.example>/m);
    expect(head).toMatch(/^References: <thr_parent>(\r?\n )?<parent-1@partner\.example>/m); // folded chain root..parent
    expect(head.toLowerCase()).not.toContain("boss@developershub.jp"); // Bcc stays off the headers
    expect(out.attachments?.[0]?.filename).toBe("photo.png");

    // Folded into the parent's conversation in Sent.
    const sentPage = (await (await req(env, "/mail/sent", "GET")).json()) as common.Paginated<mail.MailSentListItem>;
    expect(sentPage.items[0]!.threadId).toBe("thr_parent");
  });
});
