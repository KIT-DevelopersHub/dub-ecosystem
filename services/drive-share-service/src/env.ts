// Worker bindings + runtime wiring flags. This service owns NO D1 and NO Queues
// ($0): Google Drive holds the files/permissions, identity-roster is the only
// service dependency (authz). The OAuth credentials for the Hackit shared Gmail
// (hackit@gmail.com) are Workers Secrets and are NEVER logged.
//
// Auth is abstracted to ONE seam (index.ts picks the Drive client): when the three
// GOOGLE_HACKIT_OAUTH_* secrets are present the REAL Drive v3 client is wired;
// when they are absent the in-memory MOCK client runs, so the whole surface builds,
// runs, and is E2E-testable at $0 before any real refresh token exists.
import type { D1Database, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // ---- D1 (driveshare_* namespace) ----
  // Role→file grant index + provenance ledger of the Drive permissions WE created.
  // Google Drive still holds the files/permissions themselves; this is only the
  // role-based-sharing bookkeeping that makes fan-out non-destructive & reconcilable.
  DB: D1Database;

  // ---- Service Bindings ----
  SVC_IDENTITY: Fetcher; // identity-roster /authz/check (drive:read / drive:write) + role expansion

  // ---- Secrets (Hackit shared-Gmail OAuth; never logged) ----
  // A personal Gmail cannot use a service account / domain-wide delegation, so the
  // grant is a one-time-consented refresh token. All three must be present to wire
  // the real client; any missing → mock client (see index.ts).
  GOOGLE_HACKIT_OAUTH_CLIENT_ID?: string;
  GOOGLE_HACKIT_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN?: string;

  // ---- Secrets for connecting the account from ロール管理 (optional) ----
  // OAuth "Web application" client used by the connect flow (the client above is a Desktop
  // client, which cannot redirect back to the SPA). Absent => the connect flow is disabled.
  // A refresh token only works with the client that minted it, so the D1 row records which
  // client id it belongs to.
  GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID?: string;
  GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET?: string;
  // AES-GCM key (base64 of 32 bytes) sealing the connected refresh token in D1. Absent =>
  // the connect flow is disabled and only the GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN secret is used.
  DRIVESHARE_TOKEN_ENC_KEY?: string;

  // ---- Explicit mock override ----
  // Force the mock client even if secrets are set (local/preview/E2E). "1"/"true".
  DRIVESHARE_MOCK?: string;

  // ---- Tunables ----
  DRIVESHARE_LIST_PAGE_SIZE?: string; // default 50
}

export interface DriveShareConfig {
  listPageSize: number;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseConfig(env: Env): DriveShareConfig {
  return { listPageSize: num(env.DRIVESHARE_LIST_PAGE_SIZE, 50) };
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The OAuth client the connect flow uses: the Web client only. The base client is a
 *  Desktop client, which Google refuses to redirect to an https page (redirect_uri_mismatch),
 *  so offering it would make a connect button that can never succeed. */
export function connectClient(env: Env): OAuthClient | null {
  if (env.GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID && env.GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID, clientSecret: env.GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET };
  }
  return null;
}

/** The secret of whichever configured client minted a stored token (null if neither). */
export function clientById(env: Env, clientId: string): OAuthClient | null {
  for (const [id, secret] of [
    [env.GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID, env.GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET],
    [env.GOOGLE_HACKIT_OAUTH_CLIENT_ID, env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET],
  ] as const) {
    if (id && secret && id === clientId) return { clientId: id, clientSecret: secret };
  }
  return null;
}

/** True when DRIVESHARE_MOCK forces the in-memory mock Drive client. Otherwise the client
 *  is real whenever a refresh token is available (see resolveDriveCredentials). */
export function mockForced(env: Env): boolean {
  return env.DRIVESHARE_MOCK === "1" || env.DRIVESHARE_MOCK === "true";
}
