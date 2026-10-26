import { describe, it, expect } from "vitest";
import type { ScheduledController } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import handler, { createApp } from "../src/index";
import { makeEnv } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const app = createApp();

// The old daily purge fired on the 03:15–03:25 UTC tick; 03:20 is its exact slot.
const purgeSlot = Date.UTC(2026, 9, 27, 3, 20, 0);
const controller = (scheduledTime: number) => ({ scheduledTime, cron: "*/5 * * * *", noRetry() {} }) as unknown as ScheduledController;

describe("scheduled() — mail is kept indefinitely", () => {
  it("does not delete old mail / attachments / R2 blobs on the 03:20 UTC tick", async () => {
    const r2Deletes: string[] = [];
    const bucket = { get: async () => null, put: async () => undefined, delete: async (k: string) => void r2Deletes.push(k) };
    const { env, raw } = makeEnv({ R2_MAIL: bucket as never });
    const old = new Date(purgeSlot - 400 * DAY).toISOString();

    raw.prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, status, created_at, updated_at)
       VALUES ('maillog_old', 'k_old', 'h', 'svc', '[]', 's', 'sent', ?, ?)`,
    ).run(old, old);
    raw.prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
       VALUES ('mailin_old', 'm_old', 't', '{}', '[]', 's', 'snip', ?, ?)`,
    ).run(old, old);
    for (const [id, kind, msg] of [["mailatt_in", "inbound", "mailin_old"], ["mailatt_out", "sent", "maillog_old"]] as const) {
      raw.prepare(
        `INSERT INTO mail_attachments (id, message_kind, message_id, filename, mime_type, size_bytes, r2_key, created_at, status)
         VALUES (?, ?, ?, 'a.pdf', 'application/pdf', 10, ?, ?, 'stored')`,
      ).run(id, kind, msg, `r2/${id}`, old);
    }

    await handler.scheduled(controller(purgeSlot), env);

    const count = (t: string) => (raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    expect(count("mail_send_log")).toBe(1);
    expect(count("mail_inbound")).toBe(1);
    expect(count("mail_attachments")).toBe(2);
    expect(r2Deletes).toEqual([]);
  });

  it("still drains due 予約送信 on every tick, and keeps old terminal schedule rows", async () => {
    const { env, raw } = makeEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/scheduled", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dub-request-id": "req_s", "x-dub-user-id": "usr_alice" },
        body: JSON.stringify({ to: [{ email: "r@example.com" }], subject: "予約", textBody: "本文", scheduledAt: new Date(Date.now() + 3600_000).toISOString() } satisfies mail.ScheduleMailRequest),
      }),
      env,
    );
    const { id } = (await res.json()) as mail.ScheduleMailResponse;
    raw.prepare(`UPDATE mail_scheduled SET scheduled_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), id);

    await handler.scheduled(controller(purgeSlot), env);
    const row = () => raw.prepare(`SELECT status FROM mail_scheduled WHERE id = ?`).get(id) as { status: string } | undefined;
    expect(row()?.status).toBe("sent");

    raw.prepare(`UPDATE mail_scheduled SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 400 * DAY).toISOString(), id);
    await handler.scheduled(controller(purgeSlot), env);
    expect(row()?.status).toBe("sent");
  });
});
