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
  // STAGING ONLY. "1" registers POST /auth/demo-login — a password-less one-click
  // sign-in as the fixed demo account for reviewers on the shared staging URL. MUST NEVER
  // be set in production: when unset the route is not registered at all (no backdoor).
  DEMO_AUTOLOGIN?: string;
  DEMO_AUTOLOGIN_EMAIL?: string; // demo account for /auth/demo-login (default demo-admin@developershub.jp)
  COOKIE_DOMAIN?: string; // unset/empty -> host-only cookie (no Domain attr; required on *.workers.dev)
  ALLOWED_LOGIN_DOMAIN?: string; // OPTIONAL extra filter; empty (default) => no domain restriction, roster allowlist is authoritative
  SESSION_ACCESS_TTL_SEC?: string; // access lifetime (default 3600 = 1h)
  SESSION_ABS_WEB_TTL_SEC?: string; // web absolute (default 2592000 = 30d)
  SESSION_ABS_MOBILE_TTL_SEC?: string; // mobile absolute (default 15552000 = 180d)
  SESSION_REFRESH_GRACE_SEC?: string; // rotation grace window (default 30) — see sessions.ts refresh()
  PWLOGIN_MAX_FAILURES?: string; // password-login failures per window before 429 (default 5)
  PWLOGIN_WINDOW_SEC?: string; // password-login rate-limit window (default 900 = 15m)
  PASSWORD_MIN_LENGTH?: string; // min length for user/admin-set passwords (default 8)

  // --- password reversible-encryption key (admin view #5c) ---
  PASSWORD_ENC_KEY?: string; // Worker secret: base64 of 32 bytes (AES-256-GCM). Empty => admin view unavailable.

  // --- Google OAuth secrets (MOBILE ONLY — web OAuth removed) ---
  GOOGLE_MOBILE_IOS_CLIENT_ID?: string;
  GOOGLE_MOBILE_ANDROID_CLIENT_ID?: string;
}

const DEFAULTS = {
  // Empty => host-only cookie (Domain attribute omitted). Cross-subdomain sharing
  // (e.g. app./api.developershub.jp) is opt-in via an explicit COOKIE_DOMAIN var.
  cookieDomain: "",
  // Empty => domain gate OFF. Login is gated by the identity-roster active allowlist
  // (theme #4). An explicit ALLOWED_LOGIN_DOMAIN re-enables the domain filter as an
  // ADDITIONAL layer, but it must not be relied on as the sole gate (roster members
  // may hold non-company-domain emails, e.g. github-synced accounts).
  allowedLoginDomain: "",
  passwordMinLength: 8,
  accessTtlSec: 3600,
  absWebTtlSec: 30 * 24 * 60 * 60,
  absMobileTtlSec: 180 * 24 * 60 * 60,
  // Grace window (seconds) during which the pre-rotation token still resolves to
  // its successor on /auth/refresh. Absorbs concurrent refresh bursts (multi-tab
  // page loads / Promise.all) and KV read-your-write lag so a duplicate refresh
  // returns the same new token instead of a spurious "Invalid token".
  refreshGraceSec: 30,
} as const;

export interface AppConfig {
  environment: string;
  isProduction: boolean;
  testLoginEnabled: boolean;
  demoAutologin: boolean; // STAGING ONLY: register the password-less /auth/demo-login route
  demoAutologinEmail: string; // fixed demo account for /auth/demo-login
  cookieName: string;
  cookieDomain: string;
  allowedLoginDomain: string; // "" => domain gate disabled (roster allowlist authoritative)
  passwordMinLength: number;
  passwordEncKey: string; // base64 AES-256 key; "" => admin password view unavailable
  accessTtlSec: number;
  absWebTtlSec: number;
  absMobileTtlSec: number;
  refreshGraceSec: number;
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
    // Demo one-click login: gated PURELY by the explicit DEMO_AUTOLOGIN flag (staging
    // runs with ENVIRONMENT=production, so it can't key off !isProduction). The flag is
    // set ONLY in the staging auth-service config; production never sets it ⇒ the route
    // is not registered. A distinct flag (not DUB_TEST_LOGIN) keeps this a deliberate,
    // single-account demo door rather than the arbitrary-userId test-login.
    demoAutologin: env.DEMO_AUTOLOGIN === "1",
    demoAutologinEmail: (env.DEMO_AUTOLOGIN_EMAIL ?? "demo-admin@developershub.jp").trim().toLowerCase(),
    cookieName: "dub_session",
    cookieDomain: env.COOKIE_DOMAIN ?? DEFAULTS.cookieDomain,
    allowedLoginDomain: (env.ALLOWED_LOGIN_DOMAIN ?? DEFAULTS.allowedLoginDomain).trim().toLowerCase(),
    passwordMinLength: intVar(env.PASSWORD_MIN_LENGTH, DEFAULTS.passwordMinLength),
    passwordEncKey: (env.PASSWORD_ENC_KEY ?? "").trim(),
    accessTtlSec: intVar(env.SESSION_ACCESS_TTL_SEC, DEFAULTS.accessTtlSec),
    absWebTtlSec: intVar(env.SESSION_ABS_WEB_TTL_SEC, DEFAULTS.absWebTtlSec),
    absMobileTtlSec: intVar(env.SESSION_ABS_MOBILE_TTL_SEC, DEFAULTS.absMobileTtlSec),
    refreshGraceSec: intVar(env.SESSION_REFRESH_GRACE_SEC, DEFAULTS.refreshGraceSec),
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
