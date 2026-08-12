// Worker bindings + runtime wiring flags. This service owns NO D1 and NO Queues
// ($0): Google Drive holds the files/permissions, identity-roster is the only
// service dependency (authz). The OAuth credentials for the Hackit shared Gmail
// (hackit@gmail.com) are Workers Secrets and are NEVER logged.
//
// Auth is abstracted to ONE seam (index.ts picks the Drive client): when the three
// GOOGLE_HACKIT_OAUTH_* secrets are present the REAL Drive v3 client is wired;
// when they are absent the in-memory MOCK client runs, so the whole surface builds,
// runs, and is E2E-testable at $0 before any real refresh token exists.
import type { Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // ---- Service Bindings ----
  SVC_IDENTITY: Fetcher; // identity-roster /authz/check (drive:read / drive:write)

  // ---- Secrets (Hackit shared-Gmail OAuth; never logged) ----
  // A personal Gmail cannot use a service account / domain-wide delegation, so the
  // grant is a one-time-consented refresh token. All three must be present to wire
  // the real client; any missing → mock client (see index.ts).
  GOOGLE_HACKIT_OAUTH_CLIENT_ID?: string;
  GOOGLE_HACKIT_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN?: string;

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

/** True when the mock Drive client must be used: either forced via DRIVESHARE_MOCK,
 *  or the real OAuth credentials are not (all) bound yet. */
export function useMockClient(env: Env): boolean {
  if (env.DRIVESHARE_MOCK === "1" || env.DRIVESHARE_MOCK === "true") return true;
  return !(
    env.GOOGLE_HACKIT_OAUTH_CLIENT_ID &&
    env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN
  );
}
