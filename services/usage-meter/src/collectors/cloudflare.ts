// Cloudflare collector — thin Collector wrapper over the data-driven GraphQL fetch. The
// query + per-metric extraction live in cloudflare-graphql.ts (config: CF_METRIC_MAP /
// CF_CLASSIFIERS). This just wires env token/account and preserves the graceful contract:
// missing token/account -> {} (all CF metrics render "unknown").
import type { DbClient } from "@dub/db";
import { cfToken, type Env } from "../env";
import { fetchCloudflareUsage } from "../cloudflare-graphql";
import type { Collector, MetricMap } from "./index";

export const cloudflareCollector: Collector = {
  name: "cloudflare",
  async collect(env: Env, _mailDb: DbClient, now: Date, log): Promise<MetricMap> {
    const token = cfToken(env);
    const accountId = env.CF_ACCOUNT_ID;
    if (!token || !accountId) {
      log?.("cf usage skipped: missing token or account id");
      return {};
    }
    return fetchCloudflareUsage({ token, accountId }, now, log);
  },
};
