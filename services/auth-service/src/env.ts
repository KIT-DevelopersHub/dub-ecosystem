// Worker bindings + derived runtime config for auth-service.
// KV for sessions + a small D1 for the free-tier audit outbox (no paid Queues).
// Web Google OAuth was removed (login is email+password, company-domain only);
// the only remaining Google config is the MOBILE client ids used by the separate
// /mobile/exchange track. TTLs are vars (theme8).
import type { KVNamespace, D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // --- data ---
  AUTH_KV: KVNamespace; // sessions / password creds / revoked_user (binding name pending infra registry)
  OUTBOX_DB: D1Database; // @dub/freeq audit outbox (replaces the AUDIT_QUEUE producer, theme13)

  // --- service bindings ---
  SVC_IDENTITY: Fetcher; // identity-roster (POST /users/provision) — stubbed until 9-x結線
  SVC_AUDIT: Fetcher; // audit-log (drain delivery target for the audit outbox)

  // --- vars ---
  ENVIRONMENT?: string; // "local" | "preview" | "production" (default production)
  DUB_TEST_LOGIN?: string; // "1" enables /auth/test-login (local/preview only)
  COOKIE_DOMAIN?: string; // unset/empty -> host-only cookie (no Domain attr; required on *.workers.dev)
  ALLOWED_LOGIN_DOMAIN?: string; // only emails on this domain may log in (default developershub.jp)
  SESSION_ACCESS_TTL_SEC?: string; // access lifetime (default 3600 = 1h)
  SESSION_ABS_WEB_TTL_SEC?: string; // web absolute (default 2592000 = 30d)
  SESSION_ABS_MOBILE_TTL_SEC?: string; // mobile absolute (default 15552000 = 180d)
  PWLOGIN_MAX_FAILURES?: string; // password-login failures per window before 429 (default 5)
  PWLOGIN_WINDOW_SEC?: string; // password-login rate-limit window (default 900 = 15m)

  // --- Google OAuth secrets (MOBILE ONLY — web OAuth removed) ---
  GOOGLE_MOBILE_IOS_CLIENT_ID?: string;
  GOOGLE_MOBILE_ANDROID_CLIENT_ID?: string;
}

const DEFAULTS = {
  // Empty => host-only cookie (Domain attribute omitted). Cross-subdomain sharing
  // (e.g. app./api.developershub.jp) is opt-in via an explicit COOKIE_DOMAIN var.
  cookieDomain: "",
  allowedLoginDomain: "developershub.jp",
  accessTtlSec: 3600,
  absWebTtlSec: 30 * 24 * 60 * 60,
  absMobileTtlSec: 180 * 24 * 60 * 60,
} as const;

export interface AppConfig {
  environment: string;
  isProduction: boolean;
  testLoginEnabled: boolean;
  cookieName: string;
  cookieDomain: string;
  allowedLoginDomain: string;
  accessTtlSec: number;
  absWebTtlSec: number;
  absMobileTtlSec: number;
  passwordLogin: {
    maxFailures: number;
    windowSec: number;
  };
  google: {
    iosClientId: string;
    androidClientId: string;
  };
}

function intVar(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function configFromEnv(env: Env): AppConfig {
  const environment = env.ENVIRONMENT ?? "production";
  const isProduction = environment === "production";
  return {
    environment,
    isProduction,
    // test-login is compiled everywhere but hard-gated OFF in production (theme8).
    testLoginEnabled: env.DUB_TEST_LOGIN === "1" && !isProduction,
    cookieName: "dub_session",
    cookieDomain: env.COOKIE_DOMAIN ?? DEFAULTS.cookieDomain,
    allowedLoginDomain: (env.ALLOWED_LOGIN_DOMAIN ?? DEFAULTS.allowedLoginDomain).trim().toLowerCase(),
    accessTtlSec: intVar(env.SESSION_ACCESS_TTL_SEC, DEFAULTS.accessTtlSec),
    absWebTtlSec: intVar(env.SESSION_ABS_WEB_TTL_SEC, DEFAULTS.absWebTtlSec),
    absMobileTtlSec: intVar(env.SESSION_ABS_MOBILE_TTL_SEC, DEFAULTS.absMobileTtlSec),
    passwordLogin: {
      maxFailures: intVar(env.PWLOGIN_MAX_FAILURES, 5),
      windowSec: intVar(env.PWLOGIN_WINDOW_SEC, 900),
    },
    google: {
      iosClientId: env.GOOGLE_MOBILE_IOS_CLIENT_ID ?? "",
      androidClientId: env.GOOGLE_MOBILE_ANDROID_CLIENT_ID ?? "",
    },
  };
}
