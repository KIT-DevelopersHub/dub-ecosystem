import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { runAlerts, buildAlertLines, runCollectionFailureAlert, FAILURE_ALERT_AFTER, type DedupStore } from "../src/alerts";
import { buildSummary } from "../src/summary";
import type { Env } from "../src/env";
import type { SnapshotRow } from "../src/types";

const NOW = new Date("2026-08-12T09:30:00.000Z");

interface Rec {
  url: string;
  body: unknown;
}
function recorder(status = 200, body: unknown = {}): { svc: Fetcher; calls: Rec[]; fail?: boolean } {
  const calls: Rec[] = [];
  const state = { fail: false };
  const svc = {
    async fetch(input: unknown) {
      if (state.fail) throw new Error("binding down");
      // The @dub/http client calls binding.fetch(new Request(...)) — read from the Request.
      const req = input as Request;
      const url = req.url ?? String(input);
      let parsed: unknown;
      try {
        const text = await req.text();
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      calls.push({ url, body: parsed });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return Object.assign({ svc, calls }, state);
}

function memDedup(): DedupStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    async seen(k) {
      return keys.has(k);
    },
    async mark(k) {
      keys.add(k);
    },
  };
}

function row(metricKey: string, status: SnapshotRow["status"], pct: number): SnapshotRow {
  return { provider: "cloudflare", metric_key: metricKey, label: metricKey, used: pct, limit_value: 100, pct, unit: "u", overflow_behavior: "halt", status };
}

describe("runAlerts", () => {
  it("alerts admins on both channels for fresh breaches, then dedups within the day", async () => {
    const mail = recorder(200, { messageId: "m", provider: "resend", acceptedAt: "t" });
    const notif = recorder(200, { notificationId: "n", deduplicated: false });
    const env = {
      SVC_MAIL_GATEWAY: mail.svc,
      SVC_NOTIFICATION: notif.svc,
      USAGE_ALERT_ADMIN_USER_IDS: "usr_1, usr_2",
      USAGE_ALERT_EMAIL: "boss@example.com",
    } as unknown as Env;
    const summary = buildSummary([row("workers_requests_day", "critical", 95)], NOW, NOW.toISOString());
    const dedup = memDedup();

    const r1 = await runAlerts(env, summary, NOW, dedup);
    expect(r1.emailAttempted).toBe(true);
    expect(r1.inAppAttempted).toBe(true);
    expect(r1.newlyAlerted).toEqual(["workers_requests_day"]);
    expect(mail.calls).toHaveLength(1);
    expect(mail.calls[0]!.url).toContain("/send");
    expect(notif.calls).toHaveLength(1);
    expect(notif.calls[0]!.url).toContain("/notify");
    const notifyBody = notif.calls[0]!.body as { recipientIds: string[]; recipientRoles: string[] };
    expect(notifyBody.recipientIds).toEqual(["usr_1", "usr_2"]);
    // role fan-out defaults to admin/maintainer (unioned with the explicit user ids)
    expect(notifyBody.recipientRoles).toEqual(["role_sys_admin", "role_sys_maintainer"]);

    // second run same day -> deduped, no new sends
    const r2 = await runAlerts(env, summary, NOW, dedup);
    expect(r2.newlyAlerted).toEqual([]);
    expect(mail.calls).toHaveLength(1);
    expect(notif.calls).toHaveLength(1);
  });

  it("fires in-app via default role fan-out even with no admin user ids configured", async () => {
    const mail = recorder(200, { messageId: "m", provider: "resend", acceptedAt: "t" });
    const notif = recorder(200, { notificationId: "n", deduplicated: false });
    const env = { SVC_MAIL_GATEWAY: mail.svc, SVC_NOTIFICATION: notif.svc } as unknown as Env;
    const summary = buildSummary([row("resend_emails_day", "warn", 75)], NOW, NOW.toISOString());

    const r = await runAlerts(env, summary, NOW, memDedup());
    expect(r.emailAttempted).toBe(true);
    expect(r.inAppAttempted).toBe(true);
    expect(mail.calls).toHaveLength(1);
    expect(notif.calls).toHaveLength(1);
    const body = notif.calls[0]!.body as { recipientIds: string[]; recipientRoles: string[] };
    expect(body.recipientIds).toEqual([]); // no explicit user ids
    expect(body.recipientRoles).toEqual(["role_sys_admin", "role_sys_maintainer"]);
  });

  it("honors USAGE_ALERT_ADMIN_ROLE_IDS override for the in-app fan-out roles", async () => {
    const notif = recorder(200, { notificationId: "n", deduplicated: false });
    const env = {
      SVC_NOTIFICATION: notif.svc,
      USAGE_ALERT_ADMIN_ROLE_IDS: "role_ops, role_oncall",
    } as unknown as Env;
    const summary = buildSummary([row("workers_requests_day", "critical", 95)], NOW, NOW.toISOString());

    await runAlerts(env, summary, NOW, memDedup());
    expect(notif.calls).toHaveLength(1);
    expect((notif.calls[0]!.body as { recipientRoles: string[] }).recipientRoles).toEqual(["role_ops", "role_oncall"]);
  });

  it("is best-effort: a channel failure never throws and dedup still records", async () => {
    const mail = recorder();
    mail.fail = true; // make the mail binding throw
    const env = { SVC_MAIL_GATEWAY: mail.svc } as unknown as Env;
    const summary = buildSummary([row("workers_requests_day", "critical", 99)], NOW, NOW.toISOString());
    const dedup = memDedup();

    const r = await runAlerts(env, summary, NOW, dedup);
    expect(r.newlyAlerted).toEqual(["workers_requests_day"]);
    expect(dedup.keys.size).toBe(1); // marked despite the send failure
  });

  it("does nothing when there are no breaches", async () => {
    const mail = recorder();
    const env = { SVC_MAIL_GATEWAY: mail.svc } as unknown as Env;
    const summary = buildSummary([row("workers_requests_day", "ok", 10)], NOW, NOW.toISOString());
    const r = await runAlerts(env, summary, NOW, memDedup());
    expect(r.breached).toBe(0);
    expect(r.emailAttempted).toBe(false);
    expect(mail.calls).toHaveLength(0);
  });
});

describe("buildAlertLines", () => {
  it("renders one line per breach with pct + overflow behavior", () => {
    const summary = buildSummary([row("workers_requests_day", "critical", 95)], NOW, NOW.toISOString());
    const lines = buildAlertLines(summary.services.filter((s) => s.status === "critical"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CRITICAL");
    expect(lines[0]).toContain("停止");
  });
});

describe("runCollectionFailureAlert", () => {
  const health = (consecutiveFailures: number) => ({
    consecutiveFailures,
    lastError: "D1_ERROR: daily write limit exceeded",
    lastSuccessAt: "2026-08-10T20:48:00.000Z",
  });

  it("stays quiet on a single failure (one blip is not an outage)", async () => {
    const mail = recorder();
    const notif = recorder();
    const env = { SVC_MAIL_GATEWAY: mail.svc, SVC_NOTIFICATION: notif.svc } as unknown as Env;
    const sent = await runCollectionFailureAlert(env, health(1), NOW, memDedup());
    expect(sent).toBe(false);
    expect(mail.calls).toHaveLength(0);
    expect(notif.calls).toHaveLength(0);
  });

  it("alerts admins on both channels once failures repeat, with the reason and last success", async () => {
    const mail = recorder(200, { messageId: "m", provider: "resend", acceptedAt: "t" });
    const notif = recorder(200, { notificationId: "n", deduplicated: false });
    const env = { SVC_MAIL_GATEWAY: mail.svc, SVC_NOTIFICATION: notif.svc } as unknown as Env;
    const sent = await runCollectionFailureAlert(env, health(FAILURE_ALERT_AFTER), NOW, memDedup());
    expect(sent).toBe(true);

    const email = mail.calls[0]!.body as { subject: string; textBody: string };
    expect(email.subject).toContain("収集");
    expect(email.textBody).toContain("D1_ERROR: daily write limit exceeded");
    expect(email.textBody).toContain("2026-08-10T20:48:00.000Z");

    const notify = notif.calls[0]!.body as { type: string; recipientRoles: string[] };
    expect(notify.type).toBe("usage.collection_failed");
    expect(notify.recipientRoles).toEqual(["role_sys_admin", "role_sys_maintainer"]);
  });

  it("alerts at most once per UTC day while the failure continues", async () => {
    const mail = recorder();
    const env = { SVC_MAIL_GATEWAY: mail.svc } as unknown as Env;
    const dedup = memDedup();
    expect(await runCollectionFailureAlert(env, health(2), NOW, dedup)).toBe(true);
    expect(await runCollectionFailureAlert(env, health(3), NOW, dedup)).toBe(false);
    expect(mail.calls).toHaveLength(1);
    const nextDay = new Date(NOW.getTime() + 24 * 3_600_000);
    expect(await runCollectionFailureAlert(env, health(3), nextDay, dedup)).toBe(true);
  });

  it("is best-effort: a dead channel never throws", async () => {
    const mail = recorder();
    mail.fail = true;
    const env = { SVC_MAIL_GATEWAY: mail.svc } as unknown as Env;
    await expect(runCollectionFailureAlert(env, health(5), NOW, memDedup())).resolves.toBe(true);
  });
});
