// Entry for the standalone "send-only" compose Worker (see compose.ts).
// Deployed with wrangler.standalone.toml — no D1 / SVC_IDENTITY / Queues bindings, so
// a single `wrangler deploy` stands up the browser compose page + send endpoint alone.
import { createComposeApp, type ComposeEnv } from "./compose";

const app = createComposeApp();

const handler = {
  fetch(req: Request, env: ComposeEnv, ctx: unknown) {
    return app.fetch(req, env, ctx as never);
  },
};

export default handler;
export { createComposeApp };
export type { ComposeEnv };
