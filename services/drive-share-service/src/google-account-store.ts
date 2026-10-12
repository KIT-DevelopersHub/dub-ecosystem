// Persistence for the registered Hackit Google accounts (driveshare_google_accounts), which one
// is in use (driveshare_google_active_account) and the pending OAuth states
// (driveshare_google_oauth_states). D1 in production, in-memory for unit tests — same
// observable semantics, mirroring role-grants-store.ts.
import type { DbClient } from "@dub/db";

export interface GoogleAccountRow {
  id: string;
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
  /** Registered accounts by address (stable while tokens are replaced). */
  list(orgId: string): Promise<GoogleAccountRow[]>;
  /** The account in use (null = none selected → the secret fallback). */
  getActive(orgId: string): Promise<GoogleAccountRow | null>;
  /** Register an account, or replace the token of the same address in place. Returns its id. */
  upsert(row: GoogleAccountRow): Promise<string>;
  /** Point the org at one of its accounts. false = no such account in this org. */
  setActive(orgId: string, accountId: string, by: string, at: string): Promise<boolean>;
  /** Back to the secret fallback. */
  clearActive(orgId: string): Promise<void>;
  /** Delete a registered account unless it is the one in use. false = unknown or in use. */
  remove(orgId: string, accountId: string): Promise<boolean>;
  putState(row: OAuthStateRow): Promise<void>;
  /** Delete and return the state row (single use). null if unknown or already used. */
  consumeState(state: string): Promise<OAuthStateRow | null>;
  purgeExpiredStates(nowIso: string): Promise<void>;
}

interface AccountDbRow {
  id: string;
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

function toAccount(r: AccountDbRow): GoogleAccountRow {
  return {
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    clientId: r.client_id,
    tokenCipher: r.token_cipher,
    tokenIv: r.token_iv,
    connectedBy: r.connected_by,
    connectedAt: r.connected_at,
    updatedAt: r.updated_at,
  };
}

export function createD1GoogleAccountStore(db: DbClient): GoogleAccountStore {
  return {
    async list(orgId) {
      const rows = await db.all<AccountDbRow>(
        `SELECT * FROM driveshare_google_accounts WHERE org_id = ? ORDER BY email`,
        orgId,
      );
      return rows.map(toAccount);
    },
    async getActive(orgId) {
      const r = await db.first<AccountDbRow>(
        `SELECT a.* FROM driveshare_google_active_account s
           JOIN driveshare_google_accounts a ON a.id = s.account_id AND a.org_id = s.org_id
          WHERE s.org_id = ?`,
        orgId,
      );
      return r ? toAccount(r) : null;
    },
    async upsert(row) {
      const r = await db.first<{ id: string }>(
        `INSERT INTO driveshare_google_accounts
           (id, org_id, email, client_id, token_cipher, token_iv, connected_by, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, email) DO UPDATE SET
           client_id = excluded.client_id,
           token_cipher = excluded.token_cipher, token_iv = excluded.token_iv,
           connected_by = excluded.connected_by, connected_at = excluded.connected_at,
           updated_at = excluded.updated_at
         RETURNING id`,
        row.id, row.orgId, row.email, row.clientId, row.tokenCipher, row.tokenIv, row.connectedBy, row.connectedAt, row.updatedAt,
      );
      return r?.id ?? row.id;
    },
    async setActive(orgId, accountId, by, at) {
      // INSERT ... SELECT: a row is written only when the account belongs to this org.
      const res = await db.run(
        `INSERT INTO driveshare_google_active_account (org_id, account_id, switched_by, switched_at)
         SELECT org_id, id, ?, ? FROM driveshare_google_accounts WHERE org_id = ? AND id = ?
         ON CONFLICT(org_id) DO UPDATE SET
           account_id = excluded.account_id, switched_by = excluded.switched_by, switched_at = excluded.switched_at`,
        by, at, orgId, accountId,
      );
      return res.meta.changes > 0;
    },
    async clearActive(orgId) {
      await db.run(`DELETE FROM driveshare_google_active_account WHERE org_id = ?`, orgId);
    },
    async remove(orgId, accountId) {
      // One statement, so a concurrent switch to this account cannot slip between check and delete.
      const res = await db.run(
        `DELETE FROM driveshare_google_accounts
          WHERE org_id = ? AND id = ?
            AND id NOT IN (SELECT account_id FROM driveshare_google_active_account WHERE org_id = ?)`,
        orgId, accountId, orgId,
      );
      return res.meta.changes > 0;
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
  const active = new Map<string, string>();
  const states = new Map<string, OAuthStateRow>();
  const inOrg = (orgId: string, id: string) => {
    const r = accounts.get(id);
    return r && r.orgId === orgId ? r : null;
  };
  return {
    states,
    async list(orgId) {
      return [...accounts.values()]
        .filter((r) => r.orgId === orgId)
        .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
        .map((r) => ({ ...r }));
    },
    async getActive(orgId) {
      const id = active.get(orgId);
      const r = id ? inOrg(orgId, id) : null;
      return r ? { ...r } : null;
    },
    async upsert(row) {
      const same = [...accounts.values()].find((r) => r.orgId === row.orgId && r.email === row.email);
      const id = same?.id ?? row.id;
      accounts.set(id, { ...row, id });
      return id;
    },
    async setActive(orgId, accountId) {
      if (!inOrg(orgId, accountId)) return false;
      active.set(orgId, accountId);
      return true;
    },
    async clearActive(orgId) {
      active.delete(orgId);
    },
    async remove(orgId, accountId) {
      if (!inOrg(orgId, accountId) || active.get(orgId) === accountId) return false;
      accounts.delete(accountId);
      return true;
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
