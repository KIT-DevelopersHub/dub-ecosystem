// AppDeps wiring from the runtime env.
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { common } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createD1LpRepo } from "./d1-repo";
import { createCfSiteTrafficSource } from "./site-traffic";
import { createTicketReleaseClient } from "./ticket-release";
import type { Env } from "./env";
import type { AppDeps } from "./types";

const DEFAULT_LP_BASE_URL = "https://hokuriku-it-conf.com";
const DEFAULT_DAILY_VISIT_CAP = 5000;
const DEFAULT_DAILY_PROPOSAL_CAP = 200;

function siteTrafficFrom(env: Env): AppDeps["siteTraffic"] {
  const { CF_ANALYTICS_TOKEN: token, CF_ACCOUNT_ID: accountId, LP_WEB_ANALYTICS_SITE_TAG: siteTag } = env;
  return token && accountId && siteTag ? createCfSiteTrafficSource({ token, accountId, siteTag }) : null;
}

export function buildDeps(env: Env, requestId?: string): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "lp",
    ...(requestId ? { requestId } : {}),
    logger: (e) =>
      consoleSink({ level: "debug", message: "db", service: "lp-analytics", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  return {
    repo: createD1LpRepo(db),
    authz: createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: "lp-analytics", mode: "trustedHeader" }),
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    lpBaseUrl: env.LP_BASE_URL ?? DEFAULT_LP_BASE_URL,
    now: nowIso,
    newLinkId: () => newId("lnk"),
    newVisitId: () => newId("lpv"),
    dailyVisitCap: Number(env.LP_DAILY_VISIT_CAP) > 0 ? Number(env.LP_DAILY_VISIT_CAP) : DEFAULT_DAILY_VISIT_CAP,
    siteTraffic: siteTrafficFrom(env),
    ticketRelease: createTicketReleaseClient(env.SVC_LP_TICKETS, requestId ?? ""),
    newProposalId: () => newId("lpp"),
    newSiteConfigHistoryId: () => newId("lph"),
    dailyProposalCap:
      Number(env.LP_DAILY_PROPOSAL_CAP) > 0 ? Number(env.LP_DAILY_PROPOSAL_CAP) : DEFAULT_DAILY_PROPOSAL_CAP,
  };
}
