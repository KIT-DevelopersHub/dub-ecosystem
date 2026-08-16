// Collection orchestration: run every registered Collector (Cloudflare GraphQL, Resend
// send-log COUNT, …), merge their metricKey -> number maps, then turn each master metric
// into a SnapshotRow (used/limit/pct/status). Never throws — each collector degrades to a
// partial/empty map so affected metrics render "unknown". Adding a source = one registry
// entry (see collectors/index.ts).
import type { DbClient } from "@dub/db";
import type { Env } from "./env";
import { COLLECTORS } from "./collectors";
import { MASTER } from "./limits";
import { computePct, statusForPct } from "./thresholds";
import type { SnapshotRow } from "./types";

/** Build the used-value map keyed by metricKey by running + merging all collectors. */
export async function collectUsedByKey(
  env: Env,
  mailDb: DbClient,
  now: Date,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<Partial<Record<string, number>>> {
  const results = await Promise.all(COLLECTORS.map((c) => c.collect(env, mailDb, now, log)));
  const used: Record<string, number> = {};
  for (const map of results) {
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "number" && Number.isFinite(v)) used[k] = v;
    }
  }
  return used;
}

/** Turn the used-value map into a full set of snapshot rows (one per master metric). A
 *  metric with no measured value gets used=null / pct=null / status="unknown". */
export function toSnapshotRows(usedByKey: Partial<Record<string, number>>): SnapshotRow[] {
  return MASTER.map((def) => {
    const raw = usedByKey[def.metricKey];
    const used = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const pct = computePct(used, def.limit);
    return {
      provider: def.provider,
      metric_key: def.metricKey,
      label: def.label,
      used,
      limit_value: def.limit,
      pct,
      unit: def.unit,
      overflow_behavior: def.overflowBehavior,
      status: statusForPct(pct),
    };
  });
}

/** Full collection pass: fetch -> rows. */
export async function collectSnapshot(
  env: Env,
  mailDb: DbClient,
  now: Date,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<SnapshotRow[]> {
  const usedByKey = await collectUsedByKey(env, mailDb, now, log);
  return toSnapshotRows(usedByKey);
}
