// In-memory fakes for every dependency seam — no Cloudflare runtime required.
import type { KVNamespace } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import type { identity } from "@dub/types";
import { configFromEnv, type AppConfig, type Env } from "../src/env";
import { SessionService } from "../src/sessions";
import type { Deps } from "../src/deps";
import type { OAuthProvider, GoogleProfile } from "../src/oauth";
import type { IdentityClient, ProvisionResult } from "../src/identity-client";
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

function fakeUser(email: string, displayName: string): identity.IdentityUser {
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
  };
}

export class FakeIdentity implements IdentityClient {
  result: ProvisionResult = { status: "existing", user: fakeUser("alice@example.com", "Alice") };
  calls: identity.ProvisionUserRequest[] = [];
  async provision(_ctx: RequestContext, input: identity.ProvisionUserRequest): Promise<ProvisionResult> {
    this.calls.push(input);
    return this.result;
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

export function makeHarness(envOverrides: Partial<Env> = {}): TestHarness {
  const env = {
    ENVIRONMENT: "preview",
    DUB_TEST_LOGIN: "1",
    COOKIE_DOMAIN: ".test.dev",
    ALLOWED_LOGIN_DOMAIN: "developershub.jp",
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

/** Convenience: JSON POST init with optional internal marker + bearer. */
export function jsonInit(
  body: unknown,
  opts: { internal?: boolean; bearer?: string; cookie?: string } = {},
): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json", "x-dub-request-id": "req_test" };
  if (opts.internal) headers["x-dub-internal"] = "1";
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return { method: "POST", headers, body: JSON.stringify(body) };
}
