// Cloudflare Worker entry. One physical Worker per service (theme7). The app is
// rebuilt per request from bindings — buildDeps is cheap and keeps the isolate
// free of shared mutable state. The audit outbox is drained by the standalone
// freeq-drain worker (single aggregated cron), not by this service — so no
// scheduled() handler / drain cron lives here anymore. src/drain.ts is retained as
// the topic->destination contract source (audit.record) for freeq-drain's routing.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import type { Env } from "./env";

export type { Env } from "./env";
export { hashPassword, verifyPassword, seedPasswordCredential, seedDemoCredentials, DEMO_CREDENTIALS, KvPasswordStore, setCredential, generatePassword, encryptSecret, decryptSecret } from "./passwords";
export type { PasswordStore, StoredCredential, SetCredentialParams } from "./passwords";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(buildDeps(env));
    return app.fetch(request);
  },
};
