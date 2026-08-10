// Worker bindings + derived runtime config for auth-service.
// KV for sessions + a small D1 for the free-tier audit outbox (no paid Queues).
// Google OAuth secrets are Workers Secrets; TTLs are vars (theme8).
import type { KVNamespace, D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // --- data ---
  AUTH_KV: KVNamespace; // sessions / oauth_state / revoked_user (binding name pending infra registry)
  OUTBOX_DB: D1Database; // @dub/freeq audit outbox (replaces the AUDIT_QUEUE producer, theme13)

  // --- service bindings ---
  SVC_IDENTITY: Fetcher; // identity-roster (POST /users/provision) — stubbed until 9-x結線
  SVC_AUDIT: Fetcher; // audit-log (drain delivery target for the audit outbox)

  // --- vars ---
  ENVIRONMENT?: string; // "local" | "preview" | "production" (default production)
  DUB_TEST_LOGIN?: string; // "1" enables /auth/test-login (local/preview only)
  COOKIE_DOMAIN?: string; // default ".developershub.jp"
  SPA_SUCCESS_URL?: string; // fallback success redirect when no redirectUri stored
  SPA_ERROR_URL?: string; // callback failure redirect
  REDIRECT_ALLOWLIST?: string; // comma-separated allowed redirect prefixes
  SESSION_ACCESS_TTL_SEC?: string; // access lifetime (default 3600 = 1h)
  SESSION_ABS_WEB_TTL_SEC?: string; // web absolute (default 2592000 = 30d)
  SESSION_ABS_MOBILE_TTL_SEC?: string; // mobile absolute (default 15552000 = 180d)
  STATE_TTL_SEC?: string; // oauth_state lifetime (default 600 = 10m)

  // --- Google OAuth secrets ---
  GOOGLE_CLIENT_ID?: string; // web client
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string; // web callback URL registered with Google
  GOOGLE_MOBILE_IOS_CLIENT_ID?: string;
  GOOGLE_MOBILE_ANDROID_CLIENT_ID?: string;
}

const DEFAULTS = {
  cookieDomain: ".developershub.jp",
  accessTtlSec: 3600,
  absWebTtlSec: 30 * 24 * 60 * 60,
  absMobileTtlSec: 180 * 24 * 60 * 60,
  stateTtlSec: 600,
} as const;

export interface AppConfig {
  environment: string;
  isProduction: boolean;
  testLoginEnabled: boolean;
  cookieName: string;
  cookieDomain: string;
  spaSuccessUrl: string;
  spaErrorUrl: string;
  redirectAllowlist: string[];
  accessTtlSec: number;
  absWebTtlSec: number;
  absMobileTtlSec: number;
  stateTtlSec: number;
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
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
    spaSuccessUrl: env.SPA_SUCCESS_URL ?? "https://app.developershub.jp/",
    spaErrorUrl: env.SPA_ERROR_URL ?? "https://app.developershub.jp/login?error=auth",
    redirectAllowlist: (env.REDIRECT_ALLOWLIST ?? "https://app.developershub.jp")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    accessTtlSec: intVar(env.SESSION_ACCESS_TTL_SEC, DEFAULTS.accessTtlSec),
    absWebTtlSec: intVar(env.SESSION_ABS_WEB_TTL_SEC, DEFAULTS.absWebTtlSec),
    absMobileTtlSec: intVar(env.SESSION_ABS_MOBILE_TTL_SEC, DEFAULTS.absMobileTtlSec),
    stateTtlSec: intVar(env.STATE_TTL_SEC, DEFAULTS.stateTtlSec),
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirectUri: env.GOOGLE_REDIRECT_URI ?? "",
      iosClientId: env.GOOGLE_MOBILE_IOS_CLIENT_ID ?? "",
      androidClientId: env.GOOGLE_MOBILE_ANDROID_CLIENT_ID ?? "",
    },
  };
}
