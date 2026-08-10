// Dependency seam: the Hono app is built from this bag so tests can inject fakes
// (KV, OAuth, identity, audit, clock) without any Cloudflare runtime.
import type { AppConfig } from "./env";
import type { Env } from "./env";
import { configFromEnv } from "./env";
import { SessionService } from "./sessions";
import { GoogleOAuthProvider, type OAuthProvider } from "./oauth";
import { ServiceBindingIdentityClient, type IdentityClient } from "./identity-client";
import { OutboxAuditor, type Auditor } from "./audit";
import { KvPasswordStore, type PasswordStore } from "./passwords";
import { KvRateLimiter, type RateLimiter } from "./ratelimit";

export interface Deps {
  config: AppConfig;
  sessions: SessionService;
  oauth: OAuthProvider;
  identity: IdentityClient;
  audit: Auditor;
  passwords: PasswordStore;
  rateLimiter: RateLimiter;
  kvPut: (key: string, value: string, ttlSec: number) => Promise<void>;
  kvGet: (key: string) => Promise<string | null>;
  kvDelete: (key: string) => Promise<void>;
}

/** Wire the production dependencies from Worker bindings. */
export function buildDeps(env: Env): Deps {
  const config = configFromEnv(env);
  const kvPut = (k: string, v: string, ttlSec: number): Promise<void> =>
    env.AUTH_KV.put(k, v, { expirationTtl: ttlSec }).then(() => undefined);
  const kvGet = (k: string): Promise<string | null> => env.AUTH_KV.get(k);
  const kvDelete = (k: string): Promise<void> => env.AUTH_KV.delete(k);
  return {
    config,
    sessions: new SessionService(env.AUTH_KV, config),
    oauth: new GoogleOAuthProvider(config),
    identity: new ServiceBindingIdentityClient(env.SVC_IDENTITY),
    audit: new OutboxAuditor(env.OUTBOX_DB),
    passwords: new KvPasswordStore(env.AUTH_KV),
    rateLimiter: new KvRateLimiter({ get: kvGet, put: kvPut, delete: kvDelete }),
    kvPut,
    kvGet,
    kvDelete,
  };
}
