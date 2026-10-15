// AppDeps wiring from the runtime env. Split from index.ts so the reconcile Durable Object can
// build the same deps without importing the entry module.
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { common } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createD1LpRepo } from "./d1-repo";
import { createCfSiteTrafficSource } from "./site-traffic";
import { createStripeClient } from "./stripe";
import type { Env } from "./env";
import type { AppDeps } from "./types";

const DEFAULT_LP_BASE_URL = "https://hokuriku-it-conf.com";
const DEFAULT_DAILY_VISIT_CAP = 5000;
const DEFAULT_DAILY_CHECKOUT_CAP = 300;
const DEFAULT_DAILY_PROPOSAL_CAP = 200;

function siteTrafficFrom(env: Env): AppDeps["siteTraffic"] {
  const { CF_ANALYTICS_TOKEN: token, CF_ACCOUNT_ID: accountId, LP_WEB_ANALYTICS_SITE_TAG: siteTag } = env;
  return token && accountId && siteTag ? createCfSiteTrafficSource({ token, accountId, siteTag }) : null;
}

/** Payments need BOTH secrets: charging without a webhook secret risks money taken but no ticket. */
export function stripeFrom(env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">): AppDeps["stripe"] {
  return env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? createStripeClient(env.STRIPE_SECRET_KEY) : null;
}

/** Free plan only (wrangler.free.toml binds TICKET_RECONCILE_DO); the paid topology runs the cron instead. */
function reconcileArmer(env: Env): AppDeps["armReconcile"] {
  const ns = env.TICKET_RECONCILE_DO;
  if (!ns) return null;
  return async () => {
    const res = await ns.get(ns.idFromName("lp-tickets")).fetch("https://lp-tickets-reconcile/arm", { method: "POST" });
    if (!res.ok) throw new Error(`reconcile arm: ${res.status}`);
  };
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
    newTicketTypeId: () => newId("tkt"),
    newOrderId: () => newId("tko"),
    dailyCheckoutCap:
      Number(env.LP_DAILY_CHECKOUT_CAP) > 0 ? Number(env.LP_DAILY_CHECKOUT_CAP) : DEFAULT_DAILY_CHECKOUT_CAP,
    stripe: stripeFrom(env),
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    armReconcile: reconcileArmer(env),
    newProposalId: () => newId("lpp"),
    dailyProposalCap:
      Number(env.LP_DAILY_PROPOSAL_CAP) > 0 ? Number(env.LP_DAILY_PROPOSAL_CAP) : DEFAULT_DAILY_PROPOSAL_CAP,
  };
}
