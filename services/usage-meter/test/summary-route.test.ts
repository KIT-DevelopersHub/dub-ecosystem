// GET /usage/summary freshness: the dashboard must be told when the numbers are old, and a
// stale read re-arms the collection alarm (nothing else can — kick is INTERNAL-only).
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
  it("marks the 09-17 snapshot stale, reports its capture time, and re-arms the alarm", async () => {
    const meter = fakeMeterDo();
    const s = await getSummary({ DB: await seeded("2026-09-17T20:48:01.331Z"), METER_DO: meter.ns });
    expect(s.stale).toBe(true);
    expect(s.capturedAt).toBe("2026-09-17T20:48:01.331Z");
    // the old numbers are still shown (labelled old by the UI), not blanked
    expect(s.services.find((x) => x.metricKey === "workers_requests_day")!.used).toBe(10);
    expect(meter.kicks).toBe(1);
  });

  it("serves a fresh snapshot without touching the alarm", async () => {
    const meter = fakeMeterDo();
    const s = await getSummary({ DB: await seeded(new Date().toISOString()), METER_DO: meter.ns });
    expect(s.stale).toBe(false);
    expect(meter.kicks).toBe(0);
  });

  it("treats 'never collected' as stale with a null capture time", async () => {
    const meter = fakeMeterDo();
    const s = await getSummary({ DB: await seeded(null), METER_DO: meter.ns });
    expect(s.stale).toBe(true);
    expect(s.capturedAt).toBeNull();
    expect(meter.kicks).toBe(1);
  });

  it("still answers when the re-arm fails (best-effort self-heal)", async () => {
    const meter = fakeMeterDo({ fail: true });
    const s = await getSummary({ DB: await seeded("2026-09-17T20:48:01.331Z"), METER_DO: meter.ns });
    expect(s.stale).toBe(true);
  });
});
