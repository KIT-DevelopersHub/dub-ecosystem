// Cloudflare Worker entry. One physical Worker per service (theme7). The app is
// rebuilt per request from bindings — buildDeps is cheap and keeps the isolate
// free of shared mutable state. A Cron Trigger drains the audit outbox (free-tier
// replacement for the old AUDIT_QUEUE producer).
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import { runAuditDrain } from "./drain";
import type { Env } from "./env";

export type { Env } from "./env";
export { hashPassword, verifyPassword, seedPasswordCredential, seedDemoCredentials, DEMO_CREDENTIALS, KvPasswordStore } from "./passwords";
export type { PasswordStore, StoredCredential } from "./passwords";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(buildDeps(env));
    return app.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await runAuditDrain(env);
    consoleSink({
      level: "info",
      message: "auth audit outbox drained",
      service: "auth-service",
      fields: { ...result },
    });
  },
};
