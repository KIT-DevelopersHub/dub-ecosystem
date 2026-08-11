// Collection orchestration: gather raw usage (Cloudflare GraphQL + Resend send-log COUNT),
// then turn each master metric into a SnapshotRow (used/limit/pct/status). Pure aside from
// the two data fetches; never throws (each source degrades to unknown).
import type { DbClient } from "@dub/db";
import { cfToken, type Env } from "./env";
import { fetchCloudflareUsage } from "./cloudflare-graphql";
import { countResendSends } from "./resend-usage";
import { MASTER } from "./limits";
import { computePct, statusForPct } from "./thresholds";
import type { SnapshotRow } from "./types";

/** Build the used-value map keyed by metricKey from all data sources. */
export async function collectUsedByKey(
  env: Env,
  mailDb: DbClient,
  now: Date,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<Partial<Record<string, number>>> {
  const token = cfToken(env);
  const accountId = env.CF_ACCOUNT_ID;

  const cfPromise =
    token && accountId
      ? fetchCloudflareUsage({ token, accountId }, now, log)
      : Promise.resolve<Partial<Record<string, number>>>({});
  if (!token || !accountId) log?.("cf usage skipped: missing token or account id");

  const [cf, resend] = await Promise.all([cfPromise, countResendSends(mailDb, now)]);

  const used: Record<string, number> = {};
  for (const [k, v] of Object.entries(cf)) if (typeof v === "number" && Number.isFinite(v)) used[k] = v;
  if (resend.day !== null) used.resend_emails_day = resend.day;
  if (resend.month !== null) used.resend_emails_month = resend.month;
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
