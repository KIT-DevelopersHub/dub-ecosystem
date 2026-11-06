// AppDeps wiring from the runtime env. Split from index.ts so the reconcile Durable Object can
// build the same deps without importing the entry module.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { consoleSink } from "@dub/observability";
import { sharedAuthzGranter } from "@dub/policy-gate";
import { createD1TicketRepo } from "./d1-repo";
import { createResendMailer } from "./mailer";
import { createStripeClient, isLiveStripeKey, usableStripeKey } from "./stripe";
import type { Env } from "./env";
import type { AppDeps } from "./types";

const DEFAULT_LP_BASE_URL = "https://hokuriku-it-conf.com";
const DEFAULT_MAIL_FROM = "北陸ITカンファレンス <info@developershub.jp>";

/**
 * Payments need BOTH secrets (charging without a webhook secret risks money taken but no ticket)
 * and a usable key (sk_live_ only with STRIPE_ALLOW_LIVE="1").
 */
export function stripeFrom(
  env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "STRIPE_ALLOW_LIVE">,
): AppDeps["stripe"] {
  const key = usableStripeKey(env.STRIPE_SECRET_KEY, env.STRIPE_ALLOW_LIVE);
  return key && env.STRIPE_WEBHOOK_SECRET ? createStripeClient(key) : null;
}

/** Free plan only (wrangler.free.toml binds TICKET_RECONCILE_DO); the paid topology runs the cron instead. */
function reconcileArmer(env: Env): AppDeps["armReconcile"] {
  const ns = env.TICKET_RECONCILE_DO;
  if (!ns) return null;
  return async (opts) => {
    const url = `https://lp-tickets-reconcile/arm${opts?.soon ? "?soon=1" : ""}`;
    const res = await ns.get(ns.idFromName("lp-tickets")).fetch(url, { method: "POST" });
    if (!res.ok) throw new Error(`reconcile arm: ${res.status}`);
  };
}

function backupStore(env: Env): AppDeps["backup"] {
  const bucket = env.BACKUP;
  if (!bucket) return null;
  return {
    exists: async (key) => (await bucket.head(key)) !== null,
    put: async (key, json) => {
      await bucket.put(key, json, { httpMetadata: { contentType: "application/json" } });
    },
  };
}

export function buildDeps(env: Env, requestId?: string, ctx?: ExecutionContext): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "lp",
    ...(requestId ? { requestId } : {}),
    logger: (e) =>
      consoleSink({ level: "debug", message: "db", service: "lp-tickets", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  const stripeKey = usableStripeKey(env.STRIPE_SECRET_KEY, env.STRIPE_ALLOW_LIVE);
  return {
    repo: createD1TicketRepo(db),
    // sharedAuthzGranter: the app is rebuilt per request, so the identity TTL cache must be per Env.
    authz: sharedAuthzGranter(env, env.SVC_IDENTITY, { caller: "lp-tickets", ...(requestId ? { requestId } : {}) }),
    lpBaseUrl: env.LP_BASE_URL ?? DEFAULT_LP_BASE_URL,
    now: nowIso,
    newTicketTypeId: () => newId("tkt"),
    newOrderId: () => newId("tko"),
    newCouponId: () => newId("tkc"),
    stripe: stripeFrom(env),
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    armReconcile: reconcileArmer(env),
    paypayEnabled: env.LP_PAYPAY_ENABLED === "1",
    ticketPreviewKey: stripeKey && !isLiveStripeKey(stripeKey) ? stripeKey : null,
    mailer: env.RESEND_API_KEY ? createResendMailer(env.RESEND_API_KEY) : null,
    ticketTokenSecret: env.TICKET_TOKEN_SECRET || null,
    ticketOpsEmail: env.TICKET_OPS_EMAIL || null,
    ticketMailFrom: env.TICKET_MAIL_FROM || DEFAULT_MAIL_FROM,
    backup: backupStore(env),
    defer: ctx ? (work) => ctx.waitUntil(work) : null,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
