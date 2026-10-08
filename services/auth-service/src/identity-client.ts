// identity-roster client. identity is the source of truth for who may log in and
// for the canonical user id + roles. Three seams are used by auth-service:
//   - provision      : mobile-exchange invite-only gate (theme2)
//   - lookupByEmail  : password-login allowlist (active roster email → user)
//   - getUser        : resolve a session/target userId → canonical email (password mgmt)
//   - hasPermission  : identity:admin gate for the admin password endpoints
// The identity service speaks the frozen contract so this client drops in unchanged.
import type { Fetcher } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import { createServiceClient } from "@dub/http";
import { common, type identity } from "@dub/types";

// ProvisionUserRequest is frozen in @dub/types; the response is not yet, so the
// expected shape is modelled locally (identity-roster owns the canonical version).
export type ProvisionStatus = "existing" | "provisioned" | "rejected";
export interface ProvisionResult {
  status: ProvisionStatus;
  user: identity.IdentityUser | null; // null when rejected
}

/** Roster lookup by email (read-only). user is null when the email is not on the roster. */
export interface LookupResult {
  user: identity.IdentityUser | null;
}

/** A registered passkey as stored by identity (identity_webauthn_credentials). */
export interface PasskeyRecord {
  id: string; // WebAuthn credential id (base64url)
  userId: string;
  publicKey: string; // base64url COSE public key
  signCount: number;
  transports: string[];
  aaguid: string | null;
  deviceType: string | null;
  backedUp: boolean;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export type NewPasskey = Pick<PasskeyRecord, "id" | "publicKey" | "signCount" | "transports" | "aaguid" | "deviceType" | "backedUp" | "label">;

export interface StoredChallenge {
  kind: "register" | "login";
  userId: string | null;
}

/** Passkey credential + challenge store seam (identity /internal/webauthn/*). */
export interface PasskeyStore {
  saveChallenge(ctx: RequestContext, challenge: string, rec: StoredChallenge, ttlSec: number): Promise<void>;
  /** Atomic take: null when unknown, expired or already redeemed. */
  takeChallenge(ctx: RequestContext, challenge: string): Promise<StoredChallenge | null>;
  listPasskeys(ctx: RequestContext, userId: string): Promise<PasskeyRecord[]>;
  getPasskey(ctx: RequestContext, credentialId: string): Promise<PasskeyRecord | null>;
  /** null when the credential id is already registered (409). */
  createPasskey(ctx: RequestContext, userId: string, input: NewPasskey): Promise<PasskeyRecord | null>;
  recordPasskeyUse(ctx: RequestContext, credentialId: string, signCount: number): Promise<void>;
  renamePasskey(ctx: RequestContext, userId: string, credentialId: string, label: string): Promise<boolean>;
  deletePasskey(ctx: RequestContext, userId: string, credentialId: string): Promise<boolean>;
}

export interface IdentityClient extends PasskeyStore {
  provision(ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult>;
  /** Login allowlist: resolve an email to its roster user (any status) or null. */
  lookupByEmail(ctx: RequestContext, email: string): Promise<LookupResult>;
  /** Resolve a userId to its canonical roster record; null when not found. */
  getUser(ctx: RequestContext, userId: string): Promise<identity.IdentityUser | null>;
  /** True when the user holds `permission` org-wide (used for identity:admin gates). */
  hasPermission(ctx: RequestContext, userId: string, permission: identity.PermissionKey): Promise<boolean>;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string };
  return e.status === 404 || e.code === "NOT_FOUND";
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string };
  return e.status === 409 || e.code === "CONFLICT";
}

const enc = encodeURIComponent;

export class ServiceBindingIdentityClient implements IdentityClient {
  private readonly client;
  constructor(binding: Fetcher, caller = "auth-service") {
    this.client = createServiceClient(binding, { service: "identity-roster", caller });
  }

  async provision(ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult> {
    return this.client.post<ProvisionResult, identity.ProvisionUserRequest>(ctx, "/users/provision", input, {
      idempotencyKey: `provision:${input.email}`,
    });
  }

  async lookupByEmail(ctx: RequestContext, email: string): Promise<LookupResult> {
    // GET-equivalent read; retryable via an idempotency key so a transient blip on
    // login does not fail-closed on the first attempt.
    return this.client.post<LookupResult, { email: string }>(ctx, "/internal/users/lookup", { email }, {
      idempotencyKey: `lookup:${email}`,
    });
  }

  async getUser(ctx: RequestContext, userId: string): Promise<identity.IdentityUser | null> {
    try {
      return await this.client.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(userId)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async hasPermission(ctx: RequestContext, userId: string, permission: identity.PermissionKey): Promise<boolean> {
    const res = await this.client.post<identity.AuthzCheckResponse, identity.AuthzCheckRequest>(ctx, "/authz/check", {
      subjectUserId: userId,
      orgId: common.DUB_DEFAULT_ORG_ID,
      checks: [{ permission }],
    });
    return res.decisions[0]?.allowed === true;
  }
  async saveChallenge(ctx: RequestContext, challenge: string, rec: StoredChallenge, ttlSec: number): Promise<void> {
    await this.client.post<unknown, StoredChallenge & { challenge: string; ttlSec: number }>(ctx, "/internal/webauthn/challenges", {
      challenge,
      ...rec,
      ttlSec,
    });
  }

  async takeChallenge(ctx: RequestContext, challenge: string): Promise<StoredChallenge | null> {
    try {
      const r = await this.client.post<StoredChallenge, { challenge: string }>(ctx, "/internal/webauthn/challenges/take", { challenge });
      return { kind: r.kind, userId: r.userId ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listPasskeys(ctx: RequestContext, userId: string): Promise<PasskeyRecord[]> {
    const res = await this.client.get<{ items: PasskeyRecord[] }>(ctx, `/internal/webauthn/users/${enc(userId)}/credentials`);
    return res.items;
  }

  async getPasskey(ctx: RequestContext, credentialId: string): Promise<PasskeyRecord | null> {
    try {
      return await this.client.get<PasskeyRecord>(ctx, `/internal/webauthn/credentials/${enc(credentialId)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async createPasskey(ctx: RequestContext, userId: string, input: NewPasskey): Promise<PasskeyRecord | null> {
    try {
      return await this.client.post<PasskeyRecord, NewPasskey>(ctx, `/internal/webauthn/users/${enc(userId)}/credentials`, input);
    } catch (err) {
      if (isConflict(err)) return null;
      throw err;
    }
  }

  async recordPasskeyUse(ctx: RequestContext, credentialId: string, signCount: number): Promise<void> {
    await this.client.post<unknown, { signCount: number }>(ctx, `/internal/webauthn/credentials/${enc(credentialId)}/use`, { signCount });
  }

  async renamePasskey(ctx: RequestContext, userId: string, credentialId: string, label: string): Promise<boolean> {
    try {
      await this.client.patch<unknown, { label: string }>(ctx, `/internal/webauthn/users/${enc(userId)}/credentials/${enc(credentialId)}`, { label });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async deletePasskey(ctx: RequestContext, userId: string, credentialId: string): Promise<boolean> {
    try {
      await this.client.delete(ctx, `/internal/webauthn/users/${enc(userId)}/credentials/${enc(credentialId)}`);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}
