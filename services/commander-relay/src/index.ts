// commander-relay Worker entry.
//
// Two kinds of traffic arrive here:
//   1. WebSocket upgrades on the public workers.dev host — `/ws/agent` (the operator's local
//      Commander, bearer secret checked here before the DO is touched) and `/ws/browser`
//      (ticket + Origin checked inside the DO). Both go to the single CommanderRelay DO.
//   2. The HTTP API, which trusts x-dub-user-id and is therefore served ONLY to the
//      api-gateway service binding (host "svc"); a public request cannot forge that host.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createApp } from "./app";
import type { Env } from "./env";
import { secretEquals } from "./ticket";

export { CommanderRelay } from "./relay-do";

const app = createApp();

function relayStub(env: Env) {
  return env.RELAY!.get(env.RELAY!.idFromName("owner"));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (isUpgrade && (url.pathname === "/ws/agent" || url.pathname === "/ws/browser")) {
      if (!env.RELAY) return new Response("relay unavailable", { status: 503 });
      if (url.pathname === "/ws/agent") {
        const expected = env.RELAY_AGENT_SECRET;
        const header = request.headers.get("Authorization") ?? "";
        const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
        // Fail closed when unset; never let an empty secret match an empty header.
        if (!expected || !presented || !secretEquals(presented, expected)) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      return relayStub(env).fetch(request as never) as unknown as Response;
    }

    if (url.hostname !== "svc" && url.pathname !== "/health") {
      return new Response("not found", { status: 404 });
    }
    return app.fetch(request, env, ctx as never);
  },
};
