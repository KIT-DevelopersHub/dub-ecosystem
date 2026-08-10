// Dependency seam: the Hono app is built from this bag so tests can inject fakes
// (KV, OAuth, identity, audit, clock) without any Cloudflare runtime.
import type { AppConfig } from "./env";
import type { Env } from "./env";
import { configFromEnv } from "./env";
import { SessionService } from "./sessions";
import { GoogleOAuthProvider, type OAuthProvider } from "./oauth";
import { ServiceBindingIdentityClient, type IdentityClient } from "./identity-client";
import { OutboxAuditor, type Auditor } from "./audit";

export interface Deps {
  config: AppConfig;
  sessions: SessionService;
  oauth: OAuthProvider;
  identity: IdentityClient;
  audit: Auditor;
  kvPut: (key: string, value: string, ttlSec: number) => Promise<void>;
  kvGet: (key: string) => Promise<string | null>;
  kvDelete: (key: string) => Promise<void>;
}

/** Wire the production dependencies from Worker bindings. */
export function buildDeps(env: Env): Deps {
  const config = configFromEnv(env);
  return {
    config,
    sessions: new SessionService(env.AUTH_KV, config),
    oauth: new GoogleOAuthProvider(config),
    identity: new ServiceBindingIdentityClient(env.SVC_IDENTITY),
    audit: new OutboxAuditor(env.OUTBOX_DB),
    kvPut: (k, v, ttlSec) => env.AUTH_KV.put(k, v, { expirationTtl: ttlSec }).then(() => undefined),
    kvGet: (k) => env.AUTH_KV.get(k),
    kvDelete: (k) => env.AUTH_KV.delete(k),
  };
}
