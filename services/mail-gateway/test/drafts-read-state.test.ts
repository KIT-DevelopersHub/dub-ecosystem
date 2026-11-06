// 下書き (0025), POST /mail/read-state, GET /mail/status, a body-less send.
import { describe, it, expect } from "vitest";
import type { mail } from "@dub/types";
import { createApp } from "../src/app";
import { parseSendMailRequest } from "../src/validation";
import { apiText, extractAttachmentsDetailed, extractHtml } from "../src/mime";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const app = createApp();
const USERS = { usr_alice: { email: "alice@developershub.jp" }, usr_bob: { email: "bob@developershub.jp" } };
const headers = (u: string) => ({ "content-type": "application/json", "x-dub-request-id": "req_d", "x-dub-user-id": u });
type Env = ReturnType<typeof makeEnv>["env"];
function memR2(): R2Bucket {
  const store = new Map<string, ArrayBuffer>();
  return {
    put: async (key: string, body: ArrayBuffer) => void store.set(key, body),
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b, size: b.byteLength, body: b, httpMetadata: {} } : null;
    },
    delete: async (key: string) => void store.delete(key),
  } as unknown as R2Bucket;
}
const setup = () => makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, USERS), R2_MAIL: memR2() });
const call = (e: Env, u: string, method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`https://svc${path}`, { method, headers: headers(u), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), e);
const drafts = async (e: Env, u: string) => ((await (await call(e, u, "GET", "/mail/drafts")).json()) as { items: mail.MailDraft[] }).items;
const file = { filename: "a.txt", contentType: "text/plain", contentBase64: btoa("hello") };

describe("drafts", () => {
  it("saves, updates in place and lists per owner", async () => {
    const { env } = setup();
    expect((await call(env, "usr_alice", "PUT", "/mail/drafts/compose-1", { mode: "new", to: "half@", subject: "s1", body: "b1" })).status).toBe(200);
    await call(env, "usr_alice", "PUT", "/mail/drafts/compose-1", { mode: "reply", to: "a@b.co", subject: "s2", body: "b2", inReplyTo: "<m@x>" });
    const [d, ...rest] = await drafts(env, "usr_alice");
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ id: "compose-1", mode: "reply", to: "a@b.co", subject: "s2", body: "b2", inReplyTo: "<m@x>", attachments: [] });
    expect(await drafts(env, "usr_bob")).toEqual([]);
  });

  it("two accounts may mint the same id without touching each other", async () => {
    const { env } = setup();
    await call(env, "usr_alice", "PUT", "/mail/drafts/same", { subject: "alice" });
    await call(env, "usr_bob", "PUT", "/mail/drafts/same", { subject: "bob" });
    await call(env, "usr_bob", "DELETE", "/mail/drafts/same");
    expect((await drafts(env, "usr_alice"))[0]?.subject).toBe("alice");
  });

  it("delete hides it, and saving the same id again brings it back", async () => {
    const { env } = setup();
    await call(env, "usr_alice", "PUT", "/mail/drafts/x", { subject: "s" });
    expect((await call(env, "usr_alice", "DELETE", "/mail/drafts/x")).status).toBe(200);
    expect(await drafts(env, "usr_alice")).toEqual([]);
    expect((await call(env, "usr_alice", "DELETE", "/mail/drafts/never-saved")).status).toBe(200);
    await call(env, "usr_alice", "PUT", "/mail/drafts/x", { subject: "again" });
    expect((await drafts(env, "usr_alice"))[0]?.subject).toBe("again");
  });

  it("rejects an unsafe id", async () => {
    const { env } = setup();
    expect((await call(env, "usr_alice", "PUT", "/mail/drafts/a.b", { subject: "s" })).status).toBe(400);
  });

  it("stores attachments for the owner only", async () => {
    const { env } = setup();
    expect((await call(env, "usr_alice", "POST", "/mail/drafts/d/attachments", file)).status).toBe(404); // no draft yet
    await call(env, "usr_alice", "PUT", "/mail/drafts/d", { subject: "s" });
    const res = await call(env, "usr_alice", "POST", "/mail/drafts/d/attachments", file);
    expect(res.status).toBe(201);
    const att = (await res.json()) as mail.MailAttachment;
    expect((await drafts(env, "usr_alice"))[0]?.attachments).toEqual([att]);
    const get = await call(env, "usr_alice", "GET", `/mail/drafts/d/attachments/${att.id}`);
    expect(await get.text()).toBe("hello");
    expect((await call(env, "usr_bob", "GET", `/mail/drafts/d/attachments/${att.id}`)).status).toBe(404);
    await call(env, "usr_alice", "DELETE", `/mail/drafts/d/attachments/${att.id}`);
    expect((await drafts(env, "usr_alice"))[0]?.attachments).toEqual([]);
  });
});

describe("read state", () => {
  const seed = (h: ReturnType<typeof setup>) => {
    h.raw
      .prepare(`INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at, owner_user_id) VALUES ('m1','<m1@x>','t','{"email":"x@y.co"}','[]','s','sn','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','usr_alice')`)
      .run();
    h.raw
      .prepare(`INSERT INTO mail_inbound_delivery (id, inbound_id, owner_user_id, envelope_to, read_at, created_at, updated_at) VALUES ('d1','m1','usr_alice','alice@developershub.jp',NULL,'t','t')`)
      .run();
  };
  const readAt = (h: ReturnType<typeof setup>) => (h.raw.prepare(`SELECT read_at FROM mail_inbound_delivery WHERE id = 'd1'`).get() as { read_at: string | null }).read_at;

  it("marks read and back to unread, on the caller's own copy only", async () => {
    const h = setup();
    seed(h);
    await call(h.env, "usr_bob", "POST", "/mail/read-state", { ids: ["m1"], read: true });
    expect(readAt(h)).toBeNull();
    await call(h.env, "usr_alice", "POST", "/mail/read-state", { ids: ["m1"], read: true });
    expect(readAt(h)).not.toBeNull();
    await call(h.env, "usr_alice", "POST", "/mail/read-state", { ids: ["m1"], read: false });
    expect(readAt(h)).toBeNull();
  });

  it("validates the body", async () => {
    const { env } = setup();
    expect((await call(env, "usr_alice", "POST", "/mail/read-state", { ids: [], read: true })).status).toBe(400);
    expect((await call(env, "usr_alice", "POST", "/mail/read-state", { ids: ["m"] })).status).toBe(400);
  });
});

describe("status + body-less send", () => {
  it("GET /mail/status answers for an admin", async () => {
    const { env } = setup();
    const res = await call(env, "usr_alice", "GET", "/mail/status");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rateLimit: { active: boolean } }).rateLimit.active).toBe(false);
  });

  it("accepts an empty body and gives the JSON providers a non-empty text part", () => {
    expect(parseSendMailRequest({ to: [{ email: "a@b.co" }], subject: "s", textBody: "" }).textBody).toBe("");
    expect(apiText("")).toBe(" ");
    expect(apiText("x")).toBe("x");
  });
});

describe("HTML + inline images", () => {
  const raw = [
    'Content-Type: multipart/related; boundary="R"',
    "",
    "--R",
    'Content-Type: multipart/alternative; boundary="A"',
    "",
    "--A",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain",
    "--A",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>hello <img src="cid:pic1@x"></p>',
    "--A--",
    "--R",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <pic1@x>",
    "Content-Disposition: inline",
    "",
    btoa("png-bytes"),
    "--R--",
    "",
  ].join("\r\n");

  it("keeps the HTML part next to the plain text", () => {
    expect(extractHtml(raw)).toContain('<img src="cid:pic1@x">');
    expect(extractHtml("Content-Type: text/plain\r\n\r\nplain only")).toBeNull();
    expect(extractHtml(`Content-Type: text/html\r\n\r\n<p>${"x".repeat(100)}</p>`, 50)).toBeNull();
  });

  it("does not treat an attached .html file as the body", () => {
    const m = 'Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: text/html\r\nContent-Disposition: attachment; filename="a.html"\r\n\r\n<b>file</b>\r\n--B--\r\n';
    expect(extractHtml(m)).toBeNull();
  });

  it("stores a filename-less inline image with its Content-ID", () => {
    const { attachments } = extractAttachmentsDetailed(raw, { maxCount: 10, maxBytesPerFile: 1000, maxTotalBytes: 1000 });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ contentId: "pic1@x", contentType: "image/png", filename: "image-pic1.png" });
  });
});
