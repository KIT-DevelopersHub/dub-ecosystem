// Production wiring of the ports. authClient is memoized per Env so the identity
// /authz/check TTL cache survives across requests in the same isolate.
import { createDbClient } from "@dub/db";
import { createAuthClient, type AuthClient } from "@dub/auth-client";
import type { Env } from "./env";
import { SERVICE_NAME } from "./env";
import type { AppDeps } from "./ports";
import { createHttpUpstream } from "./upstream";
import { createViewRepo } from "./views";
import { createKvCache } from "./cache";

const authClientByEnv = new WeakMap<Env, AuthClient>();

function getAuthClient(env: Env): AuthClient {
  let client = authClientByEnv.get(env);
  if (!client) {
    client = createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: SERVICE_NAME, mode: "trustedHeader" });
    authClientByEnv.set(env, client);
  }
  return client;
}

export const defaultDeps: AppDeps = {
  upstream: (env) => createHttpUpstream(env),
  views: (env) => createViewRepo(createDbClient(env.DB, { namespace: "gantt" })),
  cache: (env) => createKvCache(env.GANTT_KV),
  authClient: getAuthClient,
};
