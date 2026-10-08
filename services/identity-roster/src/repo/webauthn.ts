// WebAuthn (passkey) credential store. identity owns the table (identity namespace) so
// "which authenticators belong to which roster user" lives next to the roster itself;
// auth-service performs the ceremonies and reaches this store only over the internal
// S2S API (app.ts /internal/webauthn/*). No secret material is stored: public_key is the
// COSE public key, which is safe to disclose.
//
// Every mutation is scoped by userId as well as credential id, so a confused caller can
// never rename/delete another user's authenticator by guessing its id.
import type { DbClient } from "@dub/db";

export interface WebauthnCredentialRow {
  id: string; // credential id (base64url) — globally unique, doubles as the PK
  userId: string;
  publicKey: string; // base64url COSE public key
  signCount: number;
  transports: string[];
  aaguid: string | null;
  deviceType: string | null; // "singleDevice" | "multiDevice"
  backedUp: boolean;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface WebauthnChallengeRow {
  id: string; // the challenge string itself
  kind: "register" | "login";
  userId: string | null;
  expiresAt: string;
}

export interface WebauthnRepo {
  /** Store a challenge (and sweep expired ones). */
  saveChallenge(row: WebauthnChallengeRow, now: string): Promise<void>;
  /** Atomically remove and return a challenge; null when absent or expired. */
  takeChallenge(id: string, now: string): Promise<WebauthnChallengeRow | null>;
  get(credentialId: string): Promise<WebauthnCredentialRow | null>;
  listByUser(userId: string): Promise<WebauthnCredentialRow[]>;
  /** Returns false when the credential id is already registered (to anyone). */
  create(row: WebauthnCredentialRow): Promise<boolean>;
  recordUse(credentialId: string, signCount: number, at: string): Promise<void>;
  rename(userId: string, credentialId: string, label: string, at: string): Promise<boolean>;
  delete(userId: string, credentialId: string): Promise<boolean>;
}

interface Db {
  id: string;
  user_id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
  aaguid: string | null;
  device_type: string | null;
  backed_up: number;
  label: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

function parseTransports(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function toRow(r: Db): WebauthnCredentialRow {
  return {
    id: r.id,
    userId: r.user_id,
    publicKey: r.public_key,
    signCount: r.sign_count,
    transports: parseTransports(r.transports),
    aaguid: r.aaguid,
    deviceType: r.device_type,
    backedUp: r.backed_up === 1,
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
  };
}

export class D1WebauthnRepo implements WebauthnRepo {
  constructor(private readonly db: DbClient) {}

  async saveChallenge(row: WebauthnChallengeRow, now: string): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM identity_webauthn_challenges WHERE expires_at <= ?", binds: [now] },
      {
        sql: "INSERT INTO identity_webauthn_challenges (id, kind, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        binds: [row.id, row.kind, row.userId, row.expiresAt, now, now],
      },
    ]);
  }
  async takeChallenge(id: string, now: string): Promise<WebauthnChallengeRow | null> {
    const r = await this.db.first<{ id: string; kind: string; user_id: string | null; expires_at: string }>(
      "DELETE FROM identity_webauthn_challenges WHERE id = ? RETURNING id, kind, user_id, expires_at",
      id,
    );
    if (!r || r.expires_at <= now) return null;
    return { id: r.id, kind: r.kind as WebauthnChallengeRow["kind"], userId: r.user_id, expiresAt: r.expires_at };
  }

  async get(credentialId: string): Promise<WebauthnCredentialRow | null> {
    const r = await this.db.first<Db>("SELECT * FROM identity_webauthn_credentials WHERE id = ?", credentialId);
    return r ? toRow(r) : null;
  }
  async listByUser(userId: string): Promise<WebauthnCredentialRow[]> {
    const rows = await this.db.all<Db>(
      "SELECT * FROM identity_webauthn_credentials WHERE user_id = ? ORDER BY created_at, id",
      userId,
    );
    return rows.map(toRow);
  }
  async create(row: WebauthnCredentialRow): Promise<boolean> {
    const res = await this.db.run(
      `INSERT OR IGNORE INTO identity_webauthn_credentials
        (id, user_id, public_key, sign_count, transports, aaguid, device_type, backed_up, label, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.userId,
      row.publicKey,
      row.signCount,
      JSON.stringify(row.transports),
      row.aaguid,
      row.deviceType,
      row.backedUp ? 1 : 0,
      row.label,
      row.createdAt,
      row.updatedAt,
      row.lastUsedAt,
    );
    return res.meta.changes > 0;
  }
  async recordUse(credentialId: string, signCount: number, at: string): Promise<void> {
    await this.db.run(
      // MAX(): two overlapping logins must never move the counter backwards.
      "UPDATE identity_webauthn_credentials SET sign_count = MAX(sign_count, ?), last_used_at = ?, updated_at = ? WHERE id = ?",
      signCount,
      at,
      at,
      credentialId,
    );
  }
  async rename(userId: string, credentialId: string, label: string, at: string): Promise<boolean> {
    const res = await this.db.run(
      "UPDATE identity_webauthn_credentials SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      label,
      at,
      credentialId,
      userId,
    );
    return res.meta.changes > 0;
  }
  async delete(userId: string, credentialId: string): Promise<boolean> {
    const res = await this.db.run(
      "DELETE FROM identity_webauthn_credentials WHERE id = ? AND user_id = ?",
      credentialId,
      userId,
    );
    return res.meta.changes > 0;
  }
}

/** In-memory twin for tests / local dev. Mirrors the UNIQUE(id) + user scoping. */
export class MemWebauthnRepo implements WebauthnRepo {
  private rows = new Map<string, WebauthnCredentialRow>();
  private challenges = new Map<string, WebauthnChallengeRow>();

  async saveChallenge(row: WebauthnChallengeRow, now: string): Promise<void> {
    for (const [k, c] of this.challenges) if (c.expiresAt <= now) this.challenges.delete(k);
    this.challenges.set(row.id, { ...row });
  }
  async takeChallenge(id: string, now: string): Promise<WebauthnChallengeRow | null> {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    return c && c.expiresAt > now ? c : null;
  }

  async get(credentialId: string): Promise<WebauthnCredentialRow | null> {
    const r = this.rows.get(credentialId);
    return r ? { ...r, transports: [...r.transports] } : null;
  }
  async listByUser(userId: string): Promise<WebauthnCredentialRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
      .map((r) => ({ ...r, transports: [...r.transports] }));
  }
  async create(row: WebauthnCredentialRow): Promise<boolean> {
    if (this.rows.has(row.id)) return false;
    this.rows.set(row.id, { ...row, transports: [...row.transports] });
    return true;
  }
  async recordUse(credentialId: string, signCount: number, at: string): Promise<void> {
    const r = this.rows.get(credentialId);
    if (r) this.rows.set(credentialId, { ...r, signCount: Math.max(r.signCount, signCount), lastUsedAt: at, updatedAt: at });
  }
  async rename(userId: string, credentialId: string, label: string, at: string): Promise<boolean> {
    const r = this.rows.get(credentialId);
    if (!r || r.userId !== userId) return false;
    this.rows.set(credentialId, { ...r, label, updatedAt: at });
    return true;
  }
  async delete(userId: string, credentialId: string): Promise<boolean> {
    const r = this.rows.get(credentialId);
    if (!r || r.userId !== userId) return false;
    this.rows.delete(credentialId);
    return true;
  }
}
