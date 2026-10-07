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
  absoluteExpiresAt: number; // epoch ms (refresh impossible past this); SLIDES on refresh for web
  // Last successful refresh (epoch ms). Anchors the idle deadline. OPTIONAL by design:
  // records written before this field existed have none, and `lastSeenOf()` falls back to
  // issuedAt for them — which reproduces the previous fixed-30d behaviour exactly, so no
  // already-logged-in user is force-logged-out by the deploy that introduces idle expiry.
  lastSeenAt?: number;
  // Set on the PRE-rotation record once refresh() mints a successor. Its presence
  // marks this token as "already rotated": it no longer authenticates API calls
  // (verify => revoked), but a duplicate/concurrent refresh that still carries it
  // resolves idempotently to `rotatedTo` instead of hard-failing. The record is
  // written with a short grace TTL so it self-evicts shortly after rotation.
  rotatedTo?: string;
}

const SESSION_PREFIX = "session:";
const REVOKED_PREFIX = "revoked_user:";

// Workers KV REJECTS expirationTtl < 60s (the put throws), so every TTL written here
// is floored. The floor only extends how long the KV *record* lingers — it grants no
// extra session lifetime: verify() and refresh() both re-check absoluteExpiresAt (and
// verify() also re-checks accessExpiresAt), so a floored record past its deadline
// still resolves to "revoked". Same guard as drive-proxy's cache/ratelimit.
const KV_MIN_TTL = 60;

/** Floor a TTL to the Workers KV minimum (and integer-ize it). */
function kvTtl(seconds: number): number {
  return Math.max(KV_MIN_TTL, Math.ceil(seconds));
}

function sessionKey(token: string): string {
  return SESSION_PREFIX + token;
}
function revokedKey(userId: string): string {
  return REVOKED_PREFIX + userId;
}

function toSessionInfo(s: StoredSession): auth.SessionInfo {
  return { userId: s.userId, client: s.client, sessionExpiresAt: s.accessExpiresAt };
}

/** Idle anchor. Legacy records have no lastSeenAt; issuedAt is the backward-compatible one. */
function lastSeenOf(s: StoredSession): number {
  return s.lastSeenAt ?? s.issuedAt;
}

export interface CreatedSession {
  token: string;
  session: auth.SessionInfo;
  absoluteExpiresAt: number;
  /**
   * min(absolute deadline, idle deadline) — when this session actually stops working.
   * Callers MUST size the cookie Max-Age and any KV TTL off THIS, not absoluteExpiresAt:
   * a web session that dies of idleness in 30d must not carry a 90d cookie (the browser
   * would keep sending a token the server already rejects).
   */
  effectiveExpiresAt: number;
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

  /**
   * Does a refresh RESET the absolute deadline? Web yes, mobile no.
   *
   * Web: the cookie is browser-resident and killable server-side on logout, and the 90d
   * window is re-earned only by continued use, so sliding is the right trade for "stop
   * logging active members out mid-term".
   * Mobile: the bearer token lives on the device and there is no cookie to clear, so its
   * FIXED 180d deadline is deliberately left as the one unconditional re-auth point in
   * the system. Keeping one client capped also bounds the blast radius of this change.
   */
  private isSliding(client: Client): boolean {
    return client !== "mobile";
  }

  /** Idle TTL in seconds, or 0 when idle expiry does not apply to this client (mobile). */
  private idleTtlSec(client: Client): number {
    return client === "mobile" ? 0 : this.config.idleTtlSec;
  }

  /**
   * When the session really stops working: min(absolute, idle). Everything that needs a
   * lifetime — KV expirationTtl, cookie Max-Age, verify() — goes through here so the two
   * deadlines can never drift apart.
   */
  private effectiveDeadline(s: StoredSession): number {
    const idleSec = this.idleTtlSec(s.client);
    if (idleSec <= 0) return s.absoluteExpiresAt;
    return Math.min(s.absoluteExpiresAt, lastSeenOf(s) + idleSec * 1000);
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
      lastSeenAt: now,
    };
    const token = newSessionToken();
    const effectiveExpiresAt = this.effectiveDeadline(stored);
    await this.kv.put(sessionKey(token), JSON.stringify(stored), {
      expirationTtl: kvTtl((effectiveExpiresAt - now) / 1000),
    });
    return { token, session: toSessionInfo(stored), absoluteExpiresAt: stored.absoluteExpiresAt, effectiveExpiresAt };
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
    // Effective = min(absolute, idle). Checking the absolute deadline alone is not enough
    // now that it slides: a record nobody has refreshed for idleTtl is logically dead even
    // with sliding window left, and the KV TTL floor can keep it physically present.
    if (now >= this.effectiveDeadline(stored)) return this.invalid("revoked");
    if (now >= stored.accessExpiresAt) return this.invalid("expired");
    return { valid: true, userId: stored.userId, session: toSessionInfo(stored), reason: null };
  }

  /**
   * Rotate the token and, for web, SLIDE the absolute deadline forward to a full window.
   *
   * Two deadlines govern a rotated session: the (sliding) absolute one and the idle one
   * anchored at lastSeenAt. A refresh past the idle threshold does not rotate — it rejects
   * AND deletes the record, so the stale token cannot be retried. lastSeenAt is advanced
   * ONLY here, never per request: touching it on every verify() would cost one KV write
   * per API call.
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
      if (!successor || now >= this.effectiveDeadline(successor) || successor.rotatedTo) {
        return { error: "revoked" }; // successor gone / expired / itself rotated
      }
      return {
        token: stored.rotatedTo,
        session: toSessionInfo(successor),
        absoluteExpiresAt: successor.absoluteExpiresAt,
        effectiveExpiresAt: this.effectiveDeadline(successor),
      };
    }

    if (now >= stored.absoluteExpiresAt) return { error: "revoked" };
    // Idle expiry. Nobody refreshed this session for idleTtl, so it is gone regardless of
    // the sliding window — delete the record rather than just answering "revoked", so the
    // token is unusable even while the floored KV TTL would still hold it.
    const idleSec = this.idleTtlSec(stored.client);
    if (idleSec > 0 && now >= lastSeenOf(stored) + idleSec * 1000) {
      await this.kv.delete(sessionKey(token));
      return { error: "revoked" };
    }
    // access-expired IS allowed here — that is the whole point of refresh.

    const rotated: StoredSession = {
      ...stored,
      accessExpiresAt: now + this.config.accessTtlSec * 1000,
      lastSeenAt: now,
      // Sliding (web): continued use re-earns the full window. Mobile keeps the original.
      absoluteExpiresAt: this.isSliding(stored.client)
        ? now + this.absTtlSec(stored.client) * 1000
        : stored.absoluteExpiresAt,
    };
    const newToken = newSessionToken();
    // Sized off the EFFECTIVE deadline: writing a 90d KV TTL for a record the idle rule
    // kills in 30d would leave a month of dead records occupying the free-tier namespace.
    const effectiveExpiresAt = this.effectiveDeadline(rotated);
    const remainingSec = kvTtl((effectiveExpiresAt - now) / 1000);
    await this.kv.put(sessionKey(newToken), JSON.stringify(rotated), { expirationTtl: remainingSec });
    // Grace: keep the old token briefly as a pointer to the successor instead of
    // deleting it. TTL is capped by whatever effective lifetime remains, then floored
    // to the KV minimum — an unfloored grace put (the 30s default) threw at runtime
    // and turned every hourly refresh into a 500.
    const graceSec = kvTtl(Math.min(this.config.refreshGraceSec, remainingSec));
    const graceRecord: StoredSession = { ...stored, rotatedTo: newToken };
    await this.kv.put(sessionKey(token), JSON.stringify(graceRecord), { expirationTtl: graceSec });
    return {
      token: newToken,
      session: toSessionInfo(rotated),
      absoluteExpiresAt: rotated.absoluteExpiresAt,
      effectiveExpiresAt,
    };
  }

  /** Idempotent: deleting an unknown token is a no-op success. */
  async logout(token: string): Promise<void> {
    if (token && looksLikeToken(token)) await this.kv.delete(sessionKey(token));
  }

  /** Force-revoke every session for a user (identity suspend/delete). Flag TTL = longest absolute. */
  async revokeUser(userId: string): Promise<void> {
    await this.kv.put(revokedKey(userId), "1", { expirationTtl: kvTtl(this.config.absMobileTtlSec) });
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
