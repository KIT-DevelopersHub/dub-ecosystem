// In-memory fakes for every dependency seam — no Cloudflare runtime required.
import type { KVNamespace } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import type { identity } from "@dub/types";
import { configFromEnv, type AppConfig, type Env } from "../src/env";
import { SessionService } from "../src/sessions";
import type { Deps } from "../src/deps";
import type { OAuthProvider, GoogleProfile } from "../src/oauth";
import type { IdentityClient, ProvisionResult, LookupResult } from "../src/identity-client";
import type { Auditor, AuditInput } from "../src/audit";
import { KvPasswordStore } from "../src/passwords";
import { KvRateLimiter } from "../src/ratelimit";

export class MemoryKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class FakeOAuth implements OAuthProvider {
  // Mobile-only now that web Google OAuth is removed.
  mobileProfile: GoogleProfile | Error = {
    sub: "google-sub-2",
    email: "bob@example.com",
    displayName: "Bob",
    avatarUrl: null,
  };
  async exchangeMobileCode(): Promise<GoogleProfile> {
    if (this.mobileProfile instanceof Error) throw this.mobileProfile;
    return this.mobileProfile;
  }
}

export function fakeUser(
  email: string,
  displayName: string,
  overrides: Partial<identity.IdentityUser> = {},
): identity.IdentityUser {
  return {
    id: "usr_01ABCDEF",
    orgId: "org_devhub",
    displayName,
    email,
    githubLogin: null,
    avatarUrl: null,
    status: "active",
    roleIds: [],
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    ...overrides,
  };
}

export class FakeIdentity implements IdentityClient {
  // provision (mobile-exchange path)
  result: ProvisionResult = { status: "existing", user: fakeUser("alice@example.com", "Alice") };
  calls: identity.ProvisionUserRequest[] = [];
  // allowlist lookup (password login). Default: any email resolves to an active user.
  lookupUser: identity.IdentityUser | null = fakeUser("alice@example.com", "Alice");
  lookupCalls: string[] = [];
  // userId -> canonical user (self password change + admin password mgmt)
  users = new Map<string, identity.IdentityUser>();
  // userIds that hold identity:admin
  admins = new Set<string>();

  async provision(_ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult> {
    this.calls.push(input);
    return this.result;
  }
  async lookupByEmail(_ctx: RequestContext, email: string): Promise<LookupResult> {
    this.lookupCalls.push(email);
    return { user: this.lookupUser ? { ...this.lookupUser, email: email.toLowerCase() } : null };
  }
  async getUser(_ctx: RequestContext, userId: string): Promise<identity.IdentityUser | null> {
    return this.users.get(userId) ?? null;
  }
  async hasPermission(_ctx: RequestContext, userId: string, permission: identity.PermissionKey): Promise<boolean> {
    return permission === "identity:admin" ? this.admins.has(userId) : true;
  }
}

export class FakeAuditor implements Auditor {
  records: AuditInput[] = [];
  async record(input: AuditInput): Promise<void> {
    this.records.push(input);
  }
}

export interface TestHarness {
  deps: Deps;
  kv: MemoryKV;
  oauth: FakeOAuth;
  identity: FakeIdentity;
  audit: FakeAuditor;
  config: AppConfig;
  setNow: (ms: number) => void;
}

// Valid base64 of 32 bytes (AES-256) for the password-encryption tests.
export const TEST_ENC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));

export function makeHarness(envOverrides: Partial<Env> = {}): TestHarness {
  const env = {
    ENVIRONMENT: "preview",
    DUB_TEST_LOGIN: "1",
    COOKIE_DOMAIN: ".test.dev",
    // domain filter kept ON in unit tests (default is now OFF); allowlist tests
    // exercise the roster gate independently.
    ALLOWED_LOGIN_DOMAIN: "developershub.jp",
    PASSWORD_ENC_KEY: TEST_ENC_KEY,
    SESSION_ACCESS_TTL_SEC: "3600",
    SESSION_ABS_WEB_TTL_SEC: "2592000",
    SESSION_ABS_MOBILE_TTL_SEC: "15552000",
    GOOGLE_MOBILE_IOS_CLIENT_ID: "ios-client",
    GOOGLE_MOBILE_ANDROID_CLIENT_ID: "android-client",
    ...envOverrides,
  } as unknown as Env;

  const config = configFromEnv(env);
  const kv = new MemoryKV();
  const oauth = new FakeOAuth();
  const identity = new FakeIdentity();
  const audit = new FakeAuditor();
  let now = Date.parse("2026-08-09T12:00:00Z");
  const clock = () => now;

  const kvPut = async (k: string, v: string): Promise<void> => {
    kv.store.set(k, v);
  };
  const kvGet = async (k: string): Promise<string | null> => (kv.store.has(k) ? kv.store.get(k)! : null);
  const kvDelete = async (k: string): Promise<void> => {
    kv.store.delete(k);
  };
  const deps: Deps = {
    config,
    sessions: new SessionService(kv as unknown as KVNamespace, config, clock),
    oauth,
    identity,
    audit,
    passwords: new KvPasswordStore(kv as unknown as KVNamespace),
    rateLimiter: new KvRateLimiter({ get: kvGet, put: kvPut, delete: kvDelete }),
  };

  return { deps, kv, oauth, identity, audit, config, setNow: (ms) => (now = ms) };
}

export interface ReqOpts {
  internal?: boolean;
  bearer?: string;
  cookie?: string;
  actor?: string; // x-dub-user-id (trusted actor set by the gateway)
}

function buildHeaders(opts: ReqOpts): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-dub-request-id": "req_test" };
  if (opts.internal) headers["x-dub-internal"] = "1";
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.actor) headers["x-dub-user-id"] = opts.actor;
  return headers;
}

/** Convenience: JSON POST init with optional internal marker + bearer + actor. */
export function jsonInit(body: unknown, opts: ReqOpts = {}): RequestInit {
  return { method: "POST", headers: buildHeaders(opts), body: JSON.stringify(body) };
}

/** GET init (no body) with the same optional markers. */
export function getInit(opts: ReqOpts = {}): RequestInit {
  return { method: "GET", headers: buildHeaders(opts) };
}
