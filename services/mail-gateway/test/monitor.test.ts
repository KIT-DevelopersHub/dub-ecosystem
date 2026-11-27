import { describe, it, expect } from "vitest";
import type { Fetcher, ScheduledController } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import type { identity } from "@dub/types";
import handler, { createApp } from "../src/index";
import { runCanary, type ProbeRow } from "../src/canary";
import {
  buildAlertMessage,
  createAlerter,
  decide,
  monitorConfig,
  recordCheck,
  runMailMonitor,
  type Alerter,
  type AlertMessage,
  type StateRow,
} from "../src/monitor";
import { makeEnv } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 3, 0, 0); // a :00 slot
const QA = { MAIL_CANARY_ENABLED: "true", MAIL_CANARY_TO: "qa-a@developershub.jp", MAIL_CANARY_CC: "qa-b@developershub.jp" };
const MON = { MAIL_MONITOR_ENABLED: "true" };

type Raw = ReturnType<typeof makeEnv>["raw"];
const state = (raw: Raw, name: string) => raw.prepare(`SELECT * FROM mail_monitor_state WHERE check_name = ?`).get(name) as unknown as StateRow | undefined;

function notifyRecorder(fail = false): { fetcher: Fetcher; calls: { title: string; dedupKey: string; type: string; recipientAudiences: string[] }[] } {
  const calls: { title: string; dedupKey: string; type: string; recipientAudiences: string[] }[] = [];
  const fetcher = {
    async fetch(req: Request) {
      if (fail) return new Response("down", { status: 503 });
      calls.push((await req.json()) as never);
      return new Response(JSON.stringify({ notificationId: "n1", deduplicated: false }), { status: 202, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

/** identity that allows (or denies) every permission, incl. mail:read_all. */
function identityAll(allowed: boolean): Fetcher {
  return {
    async fetch(req: Request) {
      const body = (await req.json()) as identity.AuthzCheckRequest;
      const res: identity.AuthzCheckResponse = {
        decisions: body.checks.map(() => ({ allowed, evaluatedAt: new Date().toISOString(), ttlSeconds: 0 })),
      } as identity.AuthzCheckResponse;
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
}

function recordingAlerter(delivered = true): Alerter & { msgs: AlertMessage[] } {
  const msgs: AlertMessage[] = [];
  return {
    msgs,
    async deliver(m) {
      msgs.push(m);
      return delivered;
    },
  };
}

describe("decide (pure state machine)", () => {
  it("ignores a single blip, alerts once at 2, recovers once", () => {
    let s = decide(null, false, "t1");
    expect(s).toMatchObject({ failStreak: 1, alerting: false, notice: null, incidentStartedAt: "t1" });
    s = decide(s, true, "t2");
    expect(s).toMatchObject({ failStreak: 0, alerting: false, notice: null, incidentStartedAt: null });
    s = decide(s, false, "t3");
    s = decide(s, false, "t4");
    expect(s).toMatchObject({ failStreak: 2, alerting: true, notice: "alert", incidentStartedAt: "t3" });
    s = decide(s, false, "t5");
    expect(s).toMatchObject({ failStreak: 3, alerting: true, notice: null, incidentStartedAt: "t3" });
    s = decide(s, true, "t6");
    expect(s).toMatchObject({ alerting: false, notice: "recovered", incidentStartedAt: "t3" });
    s = decide(s, true, "t7");
    expect(s.notice).toBeNull();
  });
});

describe("recordCheck (dedupe + retry)", () => {
  it("one alert and one recovered per incident, each with a stable dedup key", async () => {
    const { env } = makeEnv(MON);
    const db = createDbClient(env.DB, { namespace: "mail" });
    const alerter = recordingAlerter();
    const deps = { db, alerter };
    for (let i = 0; i < 4; i++) await recordCheck(deps, "api", { ok: false, detail: "HTTP 500" }, T0 + i * 15 * MIN);
    await recordCheck(deps, "api", { ok: true, detail: "ok" }, T0 + 60 * MIN);
    await recordCheck(deps, "api", { ok: true, detail: "ok" }, T0 + 75 * MIN);
    expect(alerter.msgs.map((m) => m.notice)).toEqual(["alert", "recovered"]);
    const start = new Date(T0).toISOString();
    expect(alerter.msgs.map((m) => m.dedupKey)).toEqual([`mail-monitor:api:${start}:alert`, `mail-monitor:api:${start}:recovered`]);
    expect(alerter.msgs[0]!.body).toContain("docs/runbooks/12-mail-incident.md");

    // a second incident gets its own key
    await recordCheck(deps, "api", { ok: false, detail: "x" }, T0 + 90 * MIN);
    await recordCheck(deps, "api", { ok: false, detail: "x" }, T0 + 105 * MIN);
    expect(alerter.msgs[2]!.dedupKey).toBe(`mail-monitor:api:${new Date(T0 + 90 * MIN).toISOString()}:alert`);
  });

  it("an undelivered alert is retried on the next result with the same key", async () => {
    const { env, raw } = makeEnv(MON);
    const db = createDbClient(env.DB, { namespace: "mail" });
    const down = recordingAlerter(false);
    await recordCheck({ db, alerter: down }, "receive", { ok: false, detail: "x" }, T0);
    await recordCheck({ db, alerter: down }, "receive", { ok: false, detail: "x" }, T0 + 15 * MIN);
    expect(down.msgs).toHaveLength(1);
    expect(state(raw, "receive")!.pending_notice).toBe("alert");

    const up = recordingAlerter(true);
    await recordCheck({ db, alerter: up }, "receive", { ok: false, detail: "x" }, T0 + 30 * MIN);
    expect(up.msgs.map((m) => [m.notice, m.dedupKey])).toEqual([["alert", down.msgs[0]!.dedupKey]]);
    expect(state(raw, "receive")!.pending_notice).toBeNull();
    await recordCheck({ db, alerter: up }, "receive", { ok: false, detail: "x" }, T0 + 45 * MIN);
    expect(up.msgs).toHaveLength(1); // delivered once, never again
  });

  it("keeps the last ref across failures (thread id of the last canary seen)", async () => {
    const { env, raw } = makeEnv(MON);
    const db = createDbClient(env.DB, { namespace: "mail" });
    const deps = { db, alerter: recordingAlerter() };
    await recordCheck(deps, "receive", { ok: true, detail: "ok", ref: "thr_1" }, T0);
    await recordCheck(deps, "receive", { ok: false, detail: "x" }, T0 + MIN);
    expect(state(raw, "receive")!.ref).toBe("thr_1");
  });
});

describe("alert channels", () => {
  it("in-app (admin audience) + Slack webhook + audit, without any mail", async () => {
    const notif = notifyRecorder();
    const { env, sends } = makeEnv({ ...MON, SVC_NOTIFICATION: notif.fetcher, MAIL_ALERT_SLACK_WEBHOOK_URL: "https://hooks.slack.example/T/B/x" });
    const slack: { url: string; body: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      slack.push({ url, body: String(init.body) });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const alerter = createAlerter(env, monitorConfig(env)!, { requestId: "r" }, fakeFetch);
    const row = { check_name: "send", fail_streak: 2, incident_started_at: new Date(T0).toISOString(), last_run_at: new Date(T0).toISOString(), last_ok_at: null, last_detail: "送信できない" } as StateRow;
    expect(await alerter.deliver(buildAlertMessage("send", "alert", row))).toBe(true);
    expect(notif.calls).toHaveLength(1);
    expect(notif.calls[0]).toMatchObject({ type: "mail.monitor_alert", recipientAudiences: ["admin"] });
    expect(slack).toHaveLength(1);
    expect(JSON.parse(slack[0]!.body).text).toContain("メール送信");
    expect(sends.audit.map((a) => a.payload.action)).toContain("mail.monitor.alert");
  });

  it("reports not delivered when every human channel fails (so it is retried)", async () => {
    const { env } = makeEnv({ ...MON, SVC_NOTIFICATION: notifyRecorder(true).fetcher });
    const alerter = createAlerter(env, monitorConfig(env)!, { requestId: "r" });
    const row = { check_name: "api", fail_streak: 2, incident_started_at: null, last_run_at: new Date(T0).toISOString(), last_ok_at: null, last_detail: null } as StateRow;
    expect(await alerter.deliver(buildAlertMessage("api", "alert", row))).toBe(false);
  });
});

describe("canary -> send / receive checks", () => {
  function arrive(raw: Raw, p: ProbeRow, rcpt: string, at: number, msgId = p.message_id!): void {
    const ts = new Date(at).toISOString();
    raw.prepare(
      `INSERT OR IGNORE INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at, header_meta_json)
       VALUES (?, ?, ?, '{}', '[]', ?, 's', ?, ?, ?)`,
    ).run(`mailin_${rcpt}_${at}`, msgId, `thr_${p.token}`, p.subject, ts, ts, JSON.stringify({ deliveredTo: rcpt }));
  }
  const probes = (raw: Raw) => raw.prepare(`SELECT * FROM mail_canary_probe ORDER BY sent_at`).all() as unknown as ProbeRow[];

  it("receive outage: alert within ~20 minutes of the first failed probe, then recovered — once each", async () => {
    const notif = notifyRecorder();
    const { env, raw } = makeEnv({ ...QA, ...MON, SVC_NOTIFICATION: notif.fetcher });
    const tick = (t: number) => runCanary(env, t, t);
    await tick(T0);
    expect(state(raw, "send")).toMatchObject({ status: "ok" });
    await tick(T0 + 10 * MIN); // probe 1 times out, confirmation probe sent
    expect(state(raw, "receive")).toMatchObject({ status: "failing", fail_streak: 1, alerting: 0 });
    await tick(T0 + 20 * MIN); // confirmation times out -> alert
    expect(notif.calls.map((c) => c.title)).toEqual([expect.stringContaining("メール受信")]);
    await tick(T0 + 30 * MIN); // slot: probe 3
    await tick(T0 + 40 * MIN); // fails again -> no second alert
    expect(notif.calls).toHaveLength(1);
    await tick(T0 + 45 * MIN);
    const p = probes(raw).at(-1)!;
    arrive(raw, p, QA.MAIL_CANARY_TO, T0 + 46 * MIN);
    arrive(raw, p, QA.MAIL_CANARY_CC, T0 + 46 * MIN, `${p.message_id}-cc`);
    await tick(T0 + 50 * MIN);
    expect(notif.calls.map((c) => c.title)).toEqual([expect.stringContaining("⚠️"), expect.stringContaining("✅")]);
    expect(state(raw, "receive")).toMatchObject({ status: "ok", alerting: 0, ref: `thr_${p.token}` });
  });

  it("send failure: alert on the confirmation probe 5 minutes later", async () => {
    const notif = notifyRecorder();
    const { env, raw } = makeEnv({ ...QA, ...MON, SVC_NOTIFICATION: notif.fetcher, MAIL_OUTBOUND_PROVIDER: "ses", MAIL_SEND_MAX_ATTEMPTS: "1" });
    await runCanary(env, T0, T0);
    expect(state(raw, "send")).toMatchObject({ status: "failing", fail_streak: 1 });
    await runCanary(env, T0 + 5 * MIN, T0 + 5 * MIN);
    expect(state(raw, "send")).toMatchObject({ status: "failing", fail_streak: 2, alerting: 1 });
    expect(notif.calls).toHaveLength(1);
    expect(notif.calls[0]!.title).toContain("メール送信");
    await runCanary(env, T0 + 10 * MIN, T0 + 10 * MIN); // alerted: no more confirmation sends
    expect(probes(raw)).toHaveLength(2);
  });

  it("monitor off: the canary writes no monitor state", async () => {
    const { env, raw } = makeEnv(QA);
    await runCanary(env, T0, T0);
    expect(raw.prepare(`SELECT COUNT(*) AS c FROM mail_monitor_state`).get()).toEqual({ c: 0 });
  });
});

describe("runMailMonitor (API + send errors + heartbeat)", () => {
  const app = createApp();
  function seedCanaryThread(raw: Raw): void {
    const ts = new Date(T0 - 30 * MIN).toISOString();
    raw.prepare(
      `INSERT INTO mail_inbound (id, message_id, thread_id, from_json, to_json, subject, snippet, received_at, created_at)
       VALUES ('mailin_c', 'm_c', 'thr_c', '{}', '[]', '[dub-canary] abc', 's', ?, ?)`,
    ).run(ts, ts);
    raw.prepare(
      `INSERT INTO mail_monitor_state (check_name, status, fail_streak, alerting, last_run_at, ref, updated_at) VALUES ('receive', 'ok', 0, 0, ?, 'thr_c', ?)`,
    ).run(ts, ts);
  }

  it("API ok under the test identity (list + canary thread); off-slot ticks do nothing", async () => {
    const { env, raw } = makeEnv({ ...MON, MAIL_MONITOR_USER_ID: "usr_monitor", SVC_IDENTITY: identityAll(true) });
    seedCanaryThread(raw);
    const r = await runMailMonitor(env, app, T0, T0, recordingAlerter());
    expect(r).toMatchObject({ enabled: true, ran: true, notices: [] });
    expect(state(raw, "api")).toMatchObject({ status: "ok" });
    expect(state(raw, "api")!.last_detail).toContain("スレッド");
    expect(state(raw, "send_errors")).toMatchObject({ status: "ok" });
    expect(state(raw, "heartbeat")).toMatchObject({ last_run_at: new Date(T0).toISOString() });
    expect((await runMailMonitor(env, app, T0 + 5 * MIN, T0 + 5 * MIN)).ran).toBe(false);
  });

  it("API broken (authz denies) twice -> one alert", async () => {
    const { env, raw } = makeEnv({ ...MON, MAIL_MONITOR_USER_ID: "usr_monitor", SVC_IDENTITY: identityAll(false) });
    seedCanaryThread(raw);
    const alerter = recordingAlerter();
    await runMailMonitor(env, app, T0, T0, alerter);
    const r = await runMailMonitor(env, app, T0 + 15 * MIN, T0 + 15 * MIN, alerter);
    expect(r.notices).toEqual([{ check: "api", notice: "alert" }]);
    expect(state(raw, "api")!.last_detail).toContain("HTTP 403");
    await runMailMonitor(env, app, T0 + 30 * MIN, T0 + 30 * MIN, alerter);
    expect(alerter.msgs).toHaveLength(1);
  });

  it("API: a thread that no longer shows the canary is a failure", async () => {
    const { env, raw } = makeEnv({ ...MON, MAIL_MONITOR_USER_ID: "usr_monitor", SVC_IDENTITY: identityAll(true) });
    seedCanaryThread(raw);
    raw.prepare(`UPDATE mail_inbound SET subject = 'other' WHERE id = 'mailin_c'`).run();
    await runMailMonitor(env, app, T0, T0, recordingAlerter());
    expect(state(raw, "api")).toMatchObject({ status: "failing" });
  });

  it("send_errors: failing when real sends mostly fail in the last hour", async () => {
    const { env, raw } = makeEnv(MON);
    const ins = raw.prepare(
      `INSERT INTO mail_send_log (id, idempotency_key, req_hash, requester, to_json, subject, status, created_at, updated_at) VALUES (?, ?, 'h', 'svc', '[]', 's', ?, ?, ?)`,
    );
    const at = new Date(T0 - 10 * MIN).toISOString();
    ins.run("l1", "k1", "sent", at, at);
    for (const i of [2, 3, 4]) ins.run(`l${i}`, `k${i}`, "failed", at, at);
    const old = new Date(T0 - 90 * MIN).toISOString();
    for (const i of [5, 6, 7, 8]) ins.run(`l${i}`, `k${i}`, "sent", old, old); // outside the window
    await runMailMonitor(env, app, T0, T0, recordingAlerter());
    expect(state(raw, "send_errors")).toMatchObject({ status: "failing" });
    expect(state(raw, "send_errors")!.last_detail).toBe("直近60分: 送信済み 1 件 / 失敗 3 件");
    // no API user configured -> no api row
    expect(state(raw, "api")).toBeUndefined();
  });

  it("scheduled() runs the monitor on its slot", async () => {
    const { env, raw } = makeEnv(MON);
    await handler.scheduled({ scheduledTime: T0, cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController, env);
    expect(state(raw, "heartbeat")).toBeDefined();
  });
});

describe("heartbeat routes", () => {
  const app = createApp();
  const internal = { "x-dub-internal": "1", "x-dub-request-id": "r" };

  it("200 while fresh, 503 when stale, 200 when the monitor is off; INTERNAL only", async () => {
    const { env } = makeEnv(MON);
    const now = Date.now();
    await runMailMonitor(env, app, Math.floor(now / (15 * MIN)) * 15 * MIN, now, recordingAlerter());
    const ok = await app.fetch(new Request("https://svc/internal/monitor/heartbeat", { headers: internal }), env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ enabled: true, fresh: true });

    const stale = makeEnv(MON);
    const old = new Date(now - 60 * MIN).toISOString();
    stale.raw.prepare(`INSERT INTO mail_monitor_state (check_name, status, last_run_at, updated_at) VALUES ('heartbeat', 'ok', ?, ?)`).run(old, old);
    const res = await app.fetch(new Request("https://svc/internal/monitor/heartbeat", { headers: internal }), stale.env);
    expect(res.status).toBe(503);

    const off = makeEnv();
    expect((await app.fetch(new Request("https://svc/internal/monitor/heartbeat", { headers: internal }), off.env)).status).toBe(200);
    const ext = await app.fetch(new Request("https://svc/internal/monitor/heartbeat", { headers: { "x-dub-request-id": "r" } }), env);
    expect(ext.status).toBe(403);
  });

  it("GET /mail/admin/monitor needs mail:admin", async () => {
    const { env } = makeEnv({ ...MON, SVC_IDENTITY: identityAll(true) });
    const res = await app.fetch(new Request("https://svc/mail/admin/monitor", { headers: { "x-dub-request-id": "r", "x-dub-user-id": "usr_admin" } }), env);
    expect(res.status).toBe(200);
    const denied = makeEnv({ ...MON, SVC_IDENTITY: identityAll(false) });
    const res2 = await app.fetch(new Request("https://svc/mail/admin/monitor", { headers: { "x-dub-request-id": "r", "x-dub-user-id": "usr_m" } }), denied.env);
    expect(res2.status).toBe(403);
  });
});
