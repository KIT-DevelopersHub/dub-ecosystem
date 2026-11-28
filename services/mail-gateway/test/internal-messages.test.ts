// GET /internal/messages/:id — mail-automation's fetch of the message a mail.message.received
// names (#852). The event carries the RFC Message-Id, and the bare /messages/:id the consumer
// used to call does not exist here, so every auto-reply event 404'd and retried forever.
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { makeEnv } from "./helpers";

const app = createApp();

function seed(raw: ReturnType<typeof makeEnv>["raw"], autoSubmitted: string | null = null): void {
  raw
    .prepare(
      `INSERT INTO mail_inbound
         (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
          auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id)
       VALUES ('mailin_01', 'CAP+abc/x@mail.gmail.com', 'thr_1', 'kotaro.takaoka', ?, ?, '[autoreply-test]', 'snip', ?, NULL,
               '2026-11-28T04:34:00.000Z', '2026-11-28T04:34:00.000Z', 'body', NULL, NULL, 'usr_kotaro')`,
    )
    .run(JSON.stringify({ email: "someone@gmail.com" }), JSON.stringify([{ email: "kotaro.takaoka@developershub.jp" }]), autoSubmitted);
}

const internal = { "x-dub-request-id": "req_int", "x-dub-internal": "1", "x-dub-caller": "mail-automation" };
const get = (env: ReturnType<typeof makeEnv>["env"], id: string, headers: Record<string, string> = internal) =>
  app.fetch(new Request(`https://svc/internal/messages/${encodeURIComponent(id)}`, { headers }), env);

describe("GET /internal/messages/:id (mail-automation fetch)", () => {
  it("403s without x-dub-internal", async () => {
    const { env, raw } = makeEnv();
    seed(raw);
    const res = await get(env, "mailin_01", { "x-dub-request-id": "req_int" });
    expect(res.status).toBe(403);
  });

  it("finds the message by the RFC Message-Id the event carries, with no user on the call", async () => {
    const { env, raw } = makeEnv();
    seed(raw);
    const res = await get(env, "CAP+abc/x@mail.gmail.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "mailin_01",
      messageId: "CAP+abc/x@mail.gmail.com",
      threadId: "thr_1",
      from: { email: "someone@gmail.com" },
      to: [{ email: "kotaro.takaoka@developershub.jp" }],
      subject: "[autoreply-test]",
      snippet: "snip",
      receivedAt: "2026-11-28T04:34:00.000Z",
      mailbox: "kotaro.takaoka",
    });
  });

  it("also finds it by mail_inbound id and restores Auto-Submitted for the loop guard", async () => {
    const { env, raw } = makeEnv();
    seed(raw, "auto-replied");
    const res = await get(env, "mailin_01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { headers?: Record<string, string> };
    expect(body.headers).toEqual({ "auto-submitted": "auto-replied" });
  });

  it("404s an unknown id", async () => {
    const { env } = makeEnv();
    const res = await get(env, "nope@x");
    expect(res.status).toBe(404);
  });
});
