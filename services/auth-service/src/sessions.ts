// Session lifecycle over KV. Public responses use the frozen auth.SessionInfo
// (userId / client / sessionExpiresAt epoch-ms — theme10). Richer bookkeeping is
// kept in an internal StoredSession record that never leaves this module.
import type { KVNamespace } from "@cloudflare/workers-types";
import type { auth } from "@dub/types";
import type { AppConfig } from "./env";
import { newSessionToken, looksLikeToken } from "./crypto";

type Client = auth.AuthClient;

interface StoredSession {
  sessionId: string;
  userId: string;
  client: Client;
  issuedAt: number; // epoch ms
  accessExpiresAt: number; // epoch ms (issued + access TTL)
  absoluteExpiresAt: number; // epoch ms (refresh impossible past this)
  // Set on the PRE-rotation record once refresh() mints a successor. Its presence
  // marks this token as "already rotated": it no longer authenticates API calls
  // (verify => revoked), but a duplicate/concurrent refresh that still carries it
  // resolves idempotently to `rotatedTo` instead of hard-failing. The record is
  // written with a short grace TTL so it self-evicts shortly after rotation.
  rotatedTo?: string;
}

const SESSION_PREFIX = "session:";
const REVOKED_PREFIX = "revoked_user:";

function sessionKey(token: string): string {
  return SESSION_PREFIX + token;
}
function revokedKey(userId: string): string {
  return REVOKED_PREFIX + userId;
}

function toSessionInfo(s: StoredSession): auth.SessionInfo {
  return { userId: s.userId, client: s.client, sessionExpiresAt: s.accessExpiresAt };
}

export interface CreatedSession {
  token: string;
  session: auth.SessionInfo;
  absoluteExpiresAt: number;
}

export interface RefreshedSession extends CreatedSession {}

/** Clock is injectable so tests can advance time deterministically. */
export type Clock = () => number;

export class SessionService {
  constructor(
    private readonly kv: KVNamespace,
    private readonly config: AppConfig,
    private readonly now: Clock = () => Date.now(),
  ) {}

  private absTtlSec(client: Client): number {
    return client === "mobile" ? this.config.absMobileTtlSec : this.config.absWebTtlSec;
  }

  private async isUserRevoked(userId: string): Promise<boolean> {
    return (await this.kv.get(revokedKey(userId))) !== null;
  }

  async create(userId: string, client: Client): Promise<CreatedSession> {
    const now = this.now();
    const absSec = this.absTtlSec(client);
    const stored: StoredSession = {
      sessionId: newSessionToken(),
      userId,
      client,
      issuedAt: now,
      accessExpiresAt: now + this.config.accessTtlSec * 1000,
      absoluteExpiresAt: now + absSec * 1000,
    };
    const token = newSessionToken();
    await this.kv.put(sessionKey(token), JSON.stringify(stored), { expirationTtl: absSec });
    return { token, session: toSessionInfo(stored), absoluteExpiresAt: stored.absoluteExpiresAt };
  }

  /** Entry-point verify (theme6). Never throws for auth outcomes — returns the contract shape. */
  async verify(token: string): Promise<auth.AuthVerifyResponse> {
    if (!token || !looksLikeToken(token)) return this.invalid("malformed");
    const stored = await this.read(token);
    if (!stored) return this.invalid("revoked"); // absent = logged out or absolute-expired (evicted)
    // A rotated token never authenticates API calls, even inside its grace window:
    // the grace only lets /auth/refresh converge on the successor (see refresh()).
    if (stored.rotatedTo) return this.invalid("revoked");
    if (await this.isUserRevoked(stored.userId)) return this.invalid("revoked");
    const now = this.now();
    if (now >= stored.absoluteExpiresAt) return this.invalid("revoked");
    if (now >= stored.accessExpiresAt) return this.invalid("expired");
    return { valid: true, userId: stored.userId, session: toSessionInfo(stored), reason: null };
  }

  /**
   * Rotate the token, preserving the original absolute deadline.
   *
   * Rotation is race-safe. Rather than deleting the old token outright, we overwrite
   * it with a short-lived GRACE record pointing at the successor (`rotatedTo`). A
   * duplicate refresh that still carries the pre-rotation token — a multi-tab page
   * load, a Promise.all burst that 401s several requests at once, or a retry sent
   * before the rotated Set-Cookie was applied — then resolves idempotently to the
   * SAME successor instead of hard-failing with "Invalid token". After the grace TTL
   * the old record self-evicts, so genuine reuse much later still resolves to revoked.
   */
  async refresh(token: string): Promise<RefreshedSession | { error: auth.AuthVerifyReason }> {
    if (!token || !looksLikeToken(token)) return { error: "malformed" };
    const stored = await this.read(token);
    if (!stored) return { error: "revoked" }; // absent old token = logout / reuse past grace
    if (await this.isUserRevoked(stored.userId)) return { error: "revoked" };
    const now = this.now();

    // Already rotated (concurrent/duplicate refresh within the grace window):
    // return the successor idempotently so every caller ends up on one token.
    if (stored.rotatedTo) {
      const successor = await this.read(stored.rotatedTo);
      if (!successor || now >= successor.absoluteExpiresAt || successor.rotatedTo) {
        return { error: "revoked" }; // successor gone / expired / itself rotated
      }
      return {
        token: stored.rotatedTo,
        session: toSessionInfo(successor),
        absoluteExpiresAt: successor.absoluteExpiresAt,
      };
    }

    if (now >= stored.absoluteExpiresAt) return { error: "revoked" };
    // access-expired IS allowed here — that is the whole point of refresh.

    const rotated: StoredSession = {
      ...stored,
      accessExpiresAt: now + this.config.accessTtlSec * 1000,
    };
    const newToken = newSessionToken();
    const remainingSec = Math.max(1, Math.ceil((stored.absoluteExpiresAt - now) / 1000));
    await this.kv.put(sessionKey(newToken), JSON.stringify(rotated), { expirationTtl: remainingSec });
    // Grace: keep the old token briefly as a pointer to the successor instead of
    // deleting it. TTL is capped by whatever absolute lifetime remains.
    const graceSec = Math.min(this.config.refreshGraceSec, remainingSec);
    const graceRecord: StoredSession = { ...stored, rotatedTo: newToken };
    await this.kv.put(sessionKey(token), JSON.stringify(graceRecord), { expirationTtl: graceSec });
    return {
      token: newToken,
      session: toSessionInfo(rotated),
      absoluteExpiresAt: rotated.absoluteExpiresAt,
    };
  }

  /** Idempotent: deleting an unknown token is a no-op success. */
  async logout(token: string): Promise<void> {
    if (token && looksLikeToken(token)) await this.kv.delete(sessionKey(token));
  }

  /** Force-revoke every session for a user (identity suspend/delete). Flag TTL = longest absolute. */
  async revokeUser(userId: string): Promise<void> {
    await this.kv.put(revokedKey(userId), "1", { expirationTtl: this.config.absMobileTtlSec });
  }

  private async read(token: string): Promise<StoredSession | null> {
    const raw = await this.kv.get(sessionKey(token));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  private invalid(reason: auth.AuthVerifyReason): auth.AuthVerifyResponse {
    return { valid: false, userId: null, session: null, reason };
  }
}
