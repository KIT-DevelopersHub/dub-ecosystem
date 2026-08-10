// Free-tier outbox shim + deps fallback. Verifies that (1) outboxQueue.send/sendBatch
// durably INSERT into freeq_outbox, and (2) when the paid Queue bindings are absent,
// buildSendDeps routes publishAudit / publishEvent through the freeq outbox so a full
// send persists both the audit record and the mail.message.sent event as durable rows.
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { buildSendDeps } from "../src/deps";
import { sendMail } from "../src/send";
import { AUDIT_TOPIC, TOPIC_NOTIFICATION, outboxQueue } from "../src/outbox";
import { MockMailProvider } from "../src/provider";
import { makeEnv, ctx } from "./helpers";
import { makeD1 } from "./d1";

function rows(raw: ReturnType<typeof makeD1>["raw"], topic?: string) {
  const sql = topic
    ? "SELECT id, topic, payload, status FROM freeq_outbox WHERE topic = ? ORDER BY created_at"
    : "SELECT id, topic, payload, status FROM freeq_outbox ORDER BY created_at";
  const stmt = raw.prepare(sql);
  return (topic ? stmt.all(topic) : stmt.all()) as Array<{ id: string; topic: string; payload: string; status: string }>;
}

describe("outboxQueue (freeq D1 shim)", () => {
  it("send() appends a pending row with topic + JSON payload", async () => {
    const { d1, raw } = makeD1();
    await outboxQueue<{ hello: string }>(d1 as D1Database, TOPIC_NOTIFICATION).send({ hello: "world" });
    const [row] = rows(raw, TOPIC_NOTIFICATION);
    expect(row!.status).toBe("pending");
    expect(JSON.parse(row!.payload)).toEqual({ hello: "world" });
  });

  it("sendBatch() appends one row per message", async () => {
    const { d1, raw } = makeD1();
    await outboxQueue<{ n: number }>(d1 as D1Database, TOPIC_NOTIFICATION).sendBatch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    expect(rows(raw, TOPIC_NOTIFICATION)).toHaveLength(2);
  });
});

describe("buildSendDeps free-tier fallback (no Queue bindings)", () => {
  it("persists audit + event as durable outbox rows on a successful send", async () => {
    // makeEnv wires recording Queues; strip them so deps falls back to the outbox.
    const { env, raw } = makeEnv();
    delete env.AUDIT_QUEUE;
    delete env.EVT_MAIL_AUTOMATION;
    delete env.EVT_NOTIFICATION;

    const deps = buildSendDeps(env, ctx("req_fb", "usr_alice"), new MockMailProvider());
    const res = await sendMail(
      deps,
      { to: [{ email: "a@b.co" }], subject: "hi", textBody: "body" },
      "idem-fallback-1",
      "usr_alice",
    );
    expect(res.status).toBe("sent");

    const audit = rows(raw, AUDIT_TOPIC);
    expect(audit).toHaveLength(1);
    const auditEnvelope = JSON.parse(audit[0]!.payload);
    expect(auditEnvelope.type).toBe("audit.record");
    expect(auditEnvelope.payload.action).toBe("mail.message.send");
    expect(auditEnvelope.payload.result).toBe("success");

    // mail.message.sent -> notification consumer topic.
    const notif = rows(raw, TOPIC_NOTIFICATION);
    expect(notif).toHaveLength(1);
    expect(JSON.parse(notif[0]!.payload).name).toBe("mail.message.sent");
  });
});
