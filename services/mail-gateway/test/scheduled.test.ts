import { describe, it, expect } from "vitest";
import { nowIso } from "@dub/db";
import { runRetentionPurge } from "../src/scheduled";
import { makeEnv } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("runRetentionPurge", () => {
  it("deletes send_log and inbound rows older than 30 days, keeps fresh ones", async () => {
    const { env, raw } = makeEnv();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const fresh = nowIso();

    raw.prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, status, created_at, updated_at)
       VALUES (?, ?, 'h', 'svc', '[]', 's', 'sent', ?, ?)`,
    ).run("maillog_old", "k_old", old, old);
    raw.prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, status, created_at, updated_at)
       VALUES (?, ?, 'h', 'svc', '[]', 's', 'sent', ?, ?)`,
    ).run("maillog_new", "k_new", fresh, fresh);
    raw.prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
       VALUES (?, ?, 't', '{}', '[]', 's', 'snip', ?, ?)`,
    ).run("mailin_old", "m_old", old, old);
    raw.prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
       VALUES (?, ?, 't', '{}', '[]', 's', 'snip', ?, ?)`,
    ).run("mailin_new", "m_new", fresh, fresh);

    const summary = await runRetentionPurge(env);
    expect(summary).toEqual({ sendLog: 1, inbound: 1, attachments: 0 });

    const sendLeft = raw.prepare(`SELECT COUNT(*) AS c FROM mail_send_log`).get() as { c: number };
    const inLeft = raw.prepare(`SELECT COUNT(*) AS c FROM mail_inbound`).get() as { c: number };
    expect(sendLeft.c).toBe(1);
    expect(inLeft.c).toBe(1);
  });
});
