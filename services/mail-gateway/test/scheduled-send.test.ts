import { describe, it, expect } from "vitest";
import type { common, mail } from "@dub/types";
import { createApp } from "../src/app";
import { runScheduledSendDrain } from "../src/scheduled-send";
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

  it("400s when a scheduled send carries attachments (unsupported this slice)", async () => {
    const { env } = makeEnv();
    const res = await req(env, "/mail/scheduled", "POST", {
      ...schedBody(),
      attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" }],
    });
    expect(res.status).toBe(400);
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
