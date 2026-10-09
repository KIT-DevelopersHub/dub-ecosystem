// Persistence for the connected Hackit Google account (driveshare_google_account) and the
// pending OAuth states (driveshare_google_oauth_states). D1 in production, in-memory for
// unit tests — same observable semantics, mirroring role-grants-store.ts.
import type { DbClient } from "@dub/db";

export interface GoogleAccountRow {
  orgId: string;
  email: string;
  clientId: string;
  tokenCipher: string;
  tokenIv: string;
  connectedBy: string;
  connectedAt: string;
  updatedAt: string;
}

export interface OAuthStateRow {
  state: string;
  orgId: string;
  userId: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
}

export interface GoogleAccountStore {
  get(orgId: string): Promise<GoogleAccountRow | null>;
  /** Insert or replace the org's single connected account. */
  put(row: GoogleAccountRow): Promise<void>;
  putState(row: OAuthStateRow): Promise<void>;
  /** Delete and return the state row (single use). null if unknown or already used. */
  consumeState(state: string): Promise<OAuthStateRow | null>;
  purgeExpiredStates(nowIso: string): Promise<void>;
}

interface AccountDbRow {
  org_id: string;
  email: string;
  client_id: string;
  token_cipher: string;
  token_iv: string;
  connected_by: string;
  connected_at: string;
  updated_at: string;
}
interface StateDbRow {
  state: string;
  org_id: string;
  user_id: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
}

export function createD1GoogleAccountStore(db: DbClient): GoogleAccountStore {
  return {
    async get(orgId) {
      const r = await db.first<AccountDbRow>(`SELECT * FROM driveshare_google_account WHERE org_id = ?`, orgId);
      return r
        ? {
            orgId: r.org_id,
            email: r.email,
            clientId: r.client_id,
            tokenCipher: r.token_cipher,
            tokenIv: r.token_iv,
            connectedBy: r.connected_by,
            connectedAt: r.connected_at,
            updatedAt: r.updated_at,
          }
        : null;
    },
    async put(row) {
      await db.run(
        `INSERT INTO driveshare_google_account
           (org_id, email, client_id, token_cipher, token_iv, connected_by, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           email = excluded.email, client_id = excluded.client_id,
           token_cipher = excluded.token_cipher, token_iv = excluded.token_iv,
           connected_by = excluded.connected_by, connected_at = excluded.connected_at,
           updated_at = excluded.updated_at`,
        row.orgId, row.email, row.clientId, row.tokenCipher, row.tokenIv, row.connectedBy, row.connectedAt, row.updatedAt,
      );
    },
    async putState(row) {
      await db.run(
        `INSERT INTO driveshare_google_oauth_states (state, org_id, user_id, redirect_uri, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.state, row.orgId, row.userId, row.redirectUri, row.createdAt, row.expiresAt,
      );
    },
    async consumeState(state) {
      // DELETE ... RETURNING makes "read then invalidate" one statement, so two concurrent
      // callbacks with the same state cannot both succeed.
      const r = await db.first<StateDbRow>(`DELETE FROM driveshare_google_oauth_states WHERE state = ? RETURNING *`, state);
      return r
        ? {
            state: r.state,
            orgId: r.org_id,
            userId: r.user_id,
            redirectUri: r.redirect_uri,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
          }
        : null;
    },
    async purgeExpiredStates(nowIso) {
      await db.run(`DELETE FROM driveshare_google_oauth_states WHERE expires_at < ?`, nowIso);
    },
  };
}

export function createInMemoryGoogleAccountStore(): GoogleAccountStore & { states: Map<string, OAuthStateRow> } {
  const accounts = new Map<string, GoogleAccountRow>();
  const states = new Map<string, OAuthStateRow>();
  return {
    states,
    async get(orgId) {
      const r = accounts.get(orgId);
      return r ? { ...r } : null;
    },
    async put(row) {
      accounts.set(row.orgId, { ...row });
    },
    async putState(row) {
      states.set(row.state, { ...row });
    },
    async consumeState(state) {
      const r = states.get(state) ?? null;
      states.delete(state);
      return r;
    },
    async purgeExpiredStates(nowIso) {
      for (const [k, r] of states) if (r.expiresAt < nowIso) states.delete(k);
    },
  };
}
