// GET /usage/summary freshness: a stale read re-arms the collection alarm (nothing else can —
// kick is INTERNAL-only) and collects inline, so the dashboard shows today's numbers even if
// the alarm never fires. If that collection fails, the old numbers are served marked stale.
import { describe, it, expect } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { HDR_USER_ID } from "@dub/observability";
import type { PermissionGranter } from "@dub/policy-gate";
import { makeD1 } from "./d1";
import { createApp } from "../src/app";
import { toSnapshotRows } from "../src/collect";
import { upsertSnapshot, usageDb } from "../src/snapshot-repo";
import type { Env } from "../src/env";
import type { UsageSummary } from "../src/types";

const allowAll: PermissionGranter = async (_u, _o, requested) => [...requested];
const EXTERNAL = { [HDR_USER_ID]: "user_admin" };

function fakeMeterDo(opts: { fail?: boolean } = {}): { ns: DurableObjectNamespace; kicks: number } {
  const rec = { kicks: 0 };
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      async fetch() {
        if (opts.fail) throw new Error("DO unavailable");
        rec.kicks++;
        return new Response(JSON.stringify({ ok: true, alarmAt: 1 }));
      },
    }),
  } as unknown as DurableObjectNamespace;
  return Object.assign(rec, { ns });
}

async function seeded(capturedAt: string | null) {
  const { d1, raw } = makeD1();
  if (capturedAt) {
    await upsertSnapshot(usageDb(d1), toSnapshotRows({ workers_requests_day: 10 }), new Date(capturedAt));
    raw.prepare("UPDATE usage_snapshot SET captured_at = ?").run(capturedAt);
  }
  return d1;
}

async function getSummary(env: Env): Promise<UsageSummary> {
  const res = await createApp({ authz: allowAll }).request("/usage/summary", { headers: EXTERNAL }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as UsageSummary;
}

describe("GET /usage/summary freshness", () => {
  it("collects inline on a stale read (09-17 snapshot) and re-arms the alarm", async () => {
    const meter = fakeMeterDo();
    const before = Date.now();
    const s = await getSummary({ DB: await seeded("2026-09-17T20:48:01.331Z"), METER_DO: meter.ns });
    expect(s.stale).toBe(false);
    expect(Date.parse(s.capturedAt!)).toBeGreaterThanOrEqual(before);
    // no CF token in tests -> the re-measured Cloudflare metric is unknown, not the 09-17 value
    expect(s.services.find((x) => x.metricKey === "workers_requests_day")!.used).toBeNull();
    expect(meter.kicks).toBe(1);
  });

  it("serves the old numbers marked stale when the inline collection fails", async () => {
    const meter = fakeMeterDo();
    const db = await seeded("2026-09-17T20:48:01.331Z");
    const failingWrites = new Proxy(db, {
      get(t, k) {
        if (k === "prepare") {
          return (sql: string) => {
            if (/^\s*(insert|update)/i.test(sql)) throw new Error("D1 write failed");
            return t.prepare(sql);
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const s = await getSummary({ DB: failingWrites, METER_DO: meter.ns });
    expect(s.stale).toBe(true);
    expect(s.capturedAt).toBe("2026-09-17T20:48:01.331Z");
    expect(s.services.find((x) => x.metricKey === "workers_requests_day")!.used).toBe(10);
  });

  it("serves a fresh snapshot without touching the alarm", async () => {
    const meter = fakeMeterDo();
    const s = await getSummary({ DB: await seeded(new Date().toISOString()), METER_DO: meter.ns });
    expect(s.stale).toBe(false);
    expect(meter.kicks).toBe(0);
  });

  it("collects inline when nothing was ever captured", async () => {
    const meter = fakeMeterDo();
    const s = await getSummary({ DB: await seeded(null), METER_DO: meter.ns });
    expect(s.stale).toBe(false);
    expect(s.capturedAt).not.toBeNull();
    expect(meter.kicks).toBe(1);
  });

  it("still answers when the re-arm fails (best-effort self-heal)", async () => {
    const meter = fakeMeterDo({ fail: true });
    const s = await getSummary({ DB: await seeded("2026-09-17T20:48:01.331Z"), METER_DO: meter.ns });
    expect(s.stale).toBe(false); // the inline collection does not depend on the DO
  });
});
