// Collector registry — the DATA-DRIVEN seam for adding usage sources. Each collector
// owns one provider's data fetch and returns a metricKey -> number map (only the keys it
// could measure). `collectUsedByKey` (collect.ts) iterates COLLECTORS and merges results.
//
// Adding a new provider (e.g. GCP) is ~1 place:
//   1. create collectors/gcp.ts exporting `gcpCollector: Collector`,
//   2. add it to the COLLECTORS array below,
//   3. add its MASTER metric rows in limits.ts (with provider: "gcp").
// Nothing else changes — snapshot rows, the summary contract, and alerts all flow from
// MASTER + the merged metric map.
import type { DbClient } from "@dub/db";
import type { Env } from "../env";
import { cloudflareCollector } from "./cloudflare";
import { resendCollector } from "./resend";

export type MetricMap = Partial<Record<string, number>>;

export interface Collector {
  /** stable id for logs. */
  name: string;
  /** Never throws — degrades to a partial/empty map so affected metrics render "unknown". */
  collect(
    env: Env,
    mailDb: DbClient,
    now: Date,
    log?: (msg: string, fields?: Record<string, unknown>) => void,
  ): Promise<MetricMap>;
}

export const COLLECTORS: readonly Collector[] = [
  cloudflareCollector,
  resendCollector,
  // gcpCollector,  // <- add here when a GCP collector + MASTER "gcp" rows land.
];
