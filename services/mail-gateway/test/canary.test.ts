import { describe, it, expect } from "vitest";
import type { ScheduledController } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import handler, { createApp } from "../src/index";
import { canaryConfig, isCanaryInbound, isSendSlot, runCanary, type ProbeRow } from "../src/canary";
import type { Env } from "../src/env";
import { fakeIdentityFetcher, makeEnv } from "./helpers";

const MIN = 60_000;
const QA = { MAIL_CANARY_ENABLED: "true", MAIL_CANARY_TO: "qa-a@developershub.jp", MAIL_CANARY_CC: "qa-b@developershub.jp" };
const T0 = Date.UTC(2026, 9, 28, 3, 0, 0); // a :00 slot (divisible by 15)

type Raw = ReturnType<typeof makeEnv>["raw"];
const probes = (raw: Raw) => raw.prepare(`SELECT * FROM mail_canary_probe ORDER BY sent_at`).all() as unknown as ProbeRow[];
const auditActions = (audit: AuditRecordEnvelopeV1[]) => audit.map((a) => a.payload.action);

/** Simulate Email Routing ingest of one recipient's copy (one row per Message-ID, as today). */
function arrive(raw: Raw, p: ProbeRow, rcpt: string, at: number, msgId = p.message_id!): void {
  const ts = new Date(at).toISOString();
  raw.prepare(
    `INSERT OR IGNORE INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at, header_meta_json)
     VALUES (?, ?, ?, '{}', '[]', ?, 's', ?, ?, ?)`,
  ).run(`mailin_${rcpt}_${at}`, msgId, msgId, p.subject, ts, ts, JSON.stringify({ deliveredTo: rcpt }));
}

describe("canary config", () => {
  it("is disabled by default and when either address is missing", async () => {
    expect(canaryConfig({} as Env)).toBeNull();
    expect(canaryConfig({ MAIL_CANARY_TO: "a@x", MAIL_CANARY_CC: "b@x" } as Env)).toBeNull();
    expect(canaryConfig({ MAIL_CANARY_ENABLED: "true", MAIL_CANARY_TO: "a@x" } as Env)).toBeNull();
    expect(canaryConfig(QA as Env)).toEqual({ to: QA.MAIL_CANARY_TO, cc: QA.MAIL_CANARY_CC, intervalMin: 15, deadlineMin: 10, expectCc: false });

    const { env, raw } = makeEnv(); // no canary vars
    const res = await runCanary(env, T0, T0);
    expect(res.enabled).toBe(false);
    await handler.scheduled({ scheduledTime: T0, cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController, env);
    expect(probes(raw)).toHaveLength(0);
    expect((raw.prepare(`SELECT COUNT(*) AS c FROM mail_send_log`).get() as { c: number }).c).toBe(0);
  });

  it("sends only on interval slots of the 5-minute cron", () => {
    expect(isSendSlot(T0, 15)).toBe(true);
    expect(isSendSlot(T0 + 5 * MIN, 15)).toBe(false);
    expect(isSendSlot(T0 + 10 * MIN, 15)).toBe(false);
    expect(isSendSlot(T0 + 15 * MIN, 15)).toBe(true);
    expect(canaryConfig({ ...QA, MAIL_CANARY_INTERVAL_MIN: "17" } as Env)?.intervalMin).toBe(15);
  });

  it("recognizes only its own inbound copy (archive-forward skip)", () => {
    const env = QA as Env;
    expect(isCanaryInbound(env, "qa-b@developershub.jp", "[dub-canary] abc")).toBe(true);
    expect(isCanaryInbound(env, "info@developershub.jp", "[dub-canary] abc")).toBe(false);
    expect(isCanaryInbound(env, "qa-a@developershub.jp", "hello")).toBe(false);
    expect(isCanaryInbound({} as Env, "qa-a@developershub.jp", "[dub-canary] abc")).toBe(false);
  });
});

describe("canary probes", () => {
  it("scheduled() sends one real probe To=QA_A Cc=QA_B, system-owned, no archive CC", async () => {
    const { env, raw } = makeEnv({ ...QA, MAIL_ARCHIVE_CC: "archive@developershub.jp" });
    await handler.scheduled({ scheduledTime: T0, cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController, env);
    // off-slot tick: no second send
    await runCanary(env, T0 + 5 * MIN, T0 + 5 * MIN);
    const [p, ...rest] = probes(raw);
    expect(rest).toHaveLength(0);
    expect(p!.status).toBe("pending");
    expect(p!.subject).toMatch(/^\[dub-canary\] [0-9a-f-]{36}$/);
    const log = raw.prepare(`SELECT to_json, cc_json, owner_user_id, subject, status FROM mail_send_log`).all() as {
      to_json: string; cc_json: string; owner_user_id: string | null; subject: string; status: string;
    }[];
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!.to_json)).toEqual([{ email: QA.MAIL_CANARY_TO }]);
    expect(JSON.parse(log[0]!.cc_json)).toEqual([{ email: QA.MAIL_CANARY_CC }]); // archive@ NOT added
    expect(log[0]!.owner_user_id).toBeNull();
    expect(log[0]!.status).toBe("sent");
  });

  it("success: both copies arrive -> ok with per-recipient latency", async () => {
    const { env, raw } = makeEnv(QA);
    await runCanary(env, T0, T0);
    const p = probes(raw)[0]!;
    arrive(raw, p, QA.MAIL_CANARY_TO, T0 + 40_000);
    arrive(raw, p, QA.MAIL_CANARY_CC, T0 + 50_000, `${p.message_id}-cc`); // future per-recipient rows
    const res = await runCanary(env, T0 + 5 * MIN, T0 + 5 * MIN);
    expect(res.finalized).toBe(1);
    const done = probes(raw)[0]!;
    expect(done).toMatchObject({ status: "ok", to_ok: 1, cc_ok: 1, to_latency_ms: 40_000, cc_latency_ms: 50_000 });
  });

  it("today's Cc-drop bug: To arrives only -> ok (cc_ok recorded false) unless EXPECT_CC", async () => {
    for (const expectCc of [false, true]) {
      const { env, raw } = makeEnv({ ...QA, ...(expectCc ? { MAIL_CANARY_EXPECT_CC: "true" } : {}) });
      await runCanary(env, T0, T0);
      const p = probes(raw)[0]!;
      arrive(raw, p, QA.MAIL_CANARY_TO, T0 + 30_000);
      arrive(raw, p, QA.MAIL_CANARY_CC, T0 + 31_000); // same Message-ID -> dropped (INSERT OR IGNORE)
      await runCanary(env, T0 + 5 * MIN, T0 + 5 * MIN);
      expect(probes(raw)[0]!.status).toBe("pending"); // waits for Cc until the deadline
      await runCanary(env, T0 + 10 * MIN, T0 + 10 * MIN);
      expect(probes(raw)[0]).toMatchObject({ status: expectCc ? "failed" : "ok", to_ok: 1, cc_ok: 0 });
    }
  });

  it("per-recipient deliveries (0018): one body row, To + Cc deliveries -> both ok", async () => {
    const { env, raw } = makeEnv({ ...QA, MAIL_CANARY_EXPECT_CC: "true" });
    await runCanary(env, T0, T0);
    const p = probes(raw)[0]!;
    arrive(raw, p, QA.MAIL_CANARY_TO, T0 + 30_000);
    const dlv = raw.prepare(
      `INSERT INTO mail_inbound_delivery (id, inbound_id, owner_user_id, envelope_to, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)`,
    );
    const inboundId = `mailin_${QA.MAIL_CANARY_TO}_${T0 + 30_000}`;
    for (const [rcpt, at] of [[QA.MAIL_CANARY_TO, T0 + 30_000], [QA.MAIL_CANARY_CC, T0 + 45_000]] as const) {
      const ts = new Date(at).toISOString();
      dlv.run(`dlv_${rcpt}`, inboundId, rcpt, ts, ts);
    }
    await runCanary(env, T0 + 5 * MIN, T0 + 5 * MIN);
    expect(probes(raw)[0]).toMatchObject({ status: "ok", to_ok: 1, cc_ok: 1, to_latency_ms: 30_000, cc_latency_ms: 45_000 });
  });

  it("timeout: nothing arrives within the deadline -> failed", async () => {
    const { env, raw } = makeEnv(QA);
    await runCanary(env, T0, T0);
    await runCanary(env, T0 + 5 * MIN, T0 + 5 * MIN);
    expect(probes(raw)[0]!.status).toBe("pending");
    await runCanary(env, T0 + 10 * MIN, T0 + 10 * MIN);
    expect(probes(raw)[0]).toMatchObject({ status: "failed", to_ok: 0, cc_ok: 0, to_latency_ms: null });
  });

  it("a provider failure is recorded as a failed probe immediately", async () => {
    // ses without credentials = loud stub that throws (no silent drop)
    const { env, raw } = makeEnv({ ...QA, MAIL_OUTBOUND_PROVIDER: "ses", MAIL_SEND_MAX_ATTEMPTS: "1" });
    await runCanary(env, T0, T0);
    const p = probes(raw)[0]!;
    expect(p).toMatchObject({ status: "failed", send_ok: 0, to_ok: 0, cc_ok: 0 });
    expect(p.send_error).toBeTruthy();
  });

  it("alerts once on the 2nd consecutive failure and notifies on recovery", async () => {
    const { env, raw, sends } = makeEnv(QA);
    const canaryAudit = () => auditActions(sends.audit).filter((a) => a.startsWith("mail.canary."));
    const tick = (t: number) => runCanary(env, t, t);

    // probe 1 @T0 times out @T0+10
    await tick(T0);
    await tick(T0 + 5 * MIN);
    let r = await tick(T0 + 10 * MIN);
    expect(r.alerts).toBe(0);
    // probe 2 @T0+15 times out @T0+25 -> ALERT
    await tick(T0 + 15 * MIN);
    await tick(T0 + 20 * MIN);
    r = await tick(T0 + 25 * MIN);
    expect(r.alerts).toBe(1);
    expect(canaryAudit()).toEqual(["mail.canary.alert"]);
    // probe 3 @T0+30 times out @T0+40 -> still failing, no re-alert
    await tick(T0 + 30 * MIN);
    await tick(T0 + 35 * MIN);
    r = await tick(T0 + 40 * MIN);
    expect(r.alerts).toBe(0);
    // probe 4 @T0+45 arrives -> RECOVERED
    await tick(T0 + 45 * MIN);
    const p4 = probes(raw)[3]!;
    arrive(raw, p4, QA.MAIL_CANARY_TO, T0 + 46 * MIN);
    arrive(raw, p4, QA.MAIL_CANARY_CC, T0 + 46 * MIN, `${p4.message_id}-cc`);
    r = await tick(T0 + 50 * MIN);
    expect(r.recoveries).toBe(1);
    expect(canaryAudit()).toEqual(["mail.canary.alert", "mail.canary.recovered"]);
    expect(probes(raw).map((p) => [p.status, p.notified])).toEqual([
      ["failed", null],
      ["failed", "alert"],
      ["failed", null],
      ["ok", "recovered"],
    ]);
  });

  it("a single failure between successes never alerts", async () => {
    const { env, raw } = makeEnv(QA);
    const tick = (t: number) => runCanary(env, t, t);
    await tick(T0);
    await tick(T0 + 10 * MIN); // fail
    await tick(T0 + 15 * MIN);
    const p = probes(raw)[1]!;
    arrive(raw, p, QA.MAIL_CANARY_TO, T0 + 16 * MIN);
    arrive(raw, p, QA.MAIL_CANARY_CC, T0 + 16 * MIN, `${p.message_id}-cc`);
    const r = await tick(T0 + 20 * MIN);
    expect(r).toMatchObject({ alerts: 0, recoveries: 0 });
  });
});

describe("GET /mail/admin/canary/probes", () => {
  const app = createApp();
  it("lists recent probes for mail:admin and is denied without it", async () => {
    const { env } = makeEnv({ ...QA, SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["mail:admin"]) });
    await runCanary(env, T0, T0);
    const res = await app.fetch(
      new Request("https://svc/mail/admin/canary/probes?limit=10", { headers: { "x-dub-request-id": "r", "x-dub-user-id": "usr_admin" } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { to: string } | null; items: { status: string; sendOk: boolean }[] };
    expect(body.config?.to).toBe(QA.MAIL_CANARY_TO);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ status: "pending", sendOk: true });

    const denied = makeEnv({ ...QA, SVC_IDENTITY: fakeIdentityFetcher(true, {}, ["mail:read", "mail:send"]) });
    const res2 = await app.fetch(
      new Request("https://svc/mail/admin/canary/probes", { headers: { "x-dub-request-id": "r", "x-dub-user-id": "usr_m" } }),
      denied.env,
    );
    expect(res2.status).toBe(403);
  });
});
