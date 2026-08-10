import type { Fetcher, Queue, KVNamespace, ExecutionContext } from "@cloudflare/workers-types";
import type { auth as authTypes } from "@dub/types";
import type { ErrorResponse } from "@dub/errors";
import type { GatewayEnv } from "../src/env";

/** Read the wire error body of a response. */
export async function errOf(res: Response): Promise<ErrorResponse["error"]> {
  return ((await res.json()) as ErrorResponse).error;
}

/** Read a typed JSON body. */
export async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface CapturedBinding {
  fetcher: Fetcher;
  requests: Request[];
}

/** Fake Service Binding: records requests (cloned) and returns scripted responses. */
export function fakeBinding(handler: (req: Request) => Response | Promise<Response>): CapturedBinding {
  const requests: Request[] = [];
  const fetcher = {
    fetch: async (req: Request) => {
      requests.push(req.clone());
      return handler(req);
    },
  } as unknown as Fetcher;
  return { fetcher, requests };
}

/** A binding that always throws (transport failure -> 502) or never resolves (timeout). */
export function failingBinding(mode: "throw" | "hang" = "throw"): Fetcher {
  return {
    fetch: async () => {
      if (mode === "hang") return new Promise<Response>(() => {});
      throw new Error("connection refused");
    },
  } as unknown as Fetcher;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** SVC_AUTH stub answering POST /verify. */
export function authBinding(result: authTypes.AuthVerifyResponse | (() => Promise<Response>)): CapturedBinding {
  return fakeBinding(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/verify") {
      if (typeof result === "function") return result();
      return json(200, result);
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } });
  });
}

export function validSession(userId = "usr_1", sessionExpiresAt = 9_999_999_999_000): authTypes.AuthVerifyResponse {
  return {
    valid: true,
    userId,
    session: { userId, client: "web", sessionExpiresAt },
    reason: null,
  };
}

export function fakeQueue(): { queue: Queue; sent: unknown[] } {
  const sent: unknown[] = [];
  const queue = {
    send: async (m: unknown) => {
      sent.push(m);
    },
    sendBatch: async (batch: Iterable<{ body: unknown }>) => {
      for (const m of batch) sent.push(m.body);
    },
  } as unknown as Queue;
  return { queue, sent };
}

export const execCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/**
 * In-memory KVNamespace fake covering the subset the gateway uses (get/put). Backed by
 * a shared Map so two apps can point at the SAME store to simulate cross-isolate state.
 * `expirationTtl` is accepted and ignored (tests drive time via the injectable clock).
 */
export function fakeKv(store: Map<string, string> = new Map()): { kv: KVNamespace; store: Map<string, string> } {
  const kv = {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

/** Build a full GatewayEnv; unspecified bindings are inert fetchers returning 200 {}. */
export function makeEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  const inert = () => fakeBinding(() => json(200, {})).fetcher;
  const base: GatewayEnv = {
    SVC_AUTH: inert(),
    SVC_IDENTITY: inert(),
    SVC_EVENT: inert(),
    SVC_TASK: inert(),
    SVC_GANTT: inert(),
    SVC_NOTIFICATION: inert(),
    SVC_FILE_META: inert(),
    SVC_DRIVE_PROXY: inert(),
    SVC_CHAT: inert(),
    SVC_MAIL_GATEWAY: inert(),
    SVC_DEPLOY: inert(),
    SVC_GITHUB_SYNC: inert(),
    SVC_AUDIT_LOG: inert(),
    SVC_WEBHOOK_INGEST: inert(),
    GATEWAY_VERSION: "test-1",
    ALLOWED_ORIGINS: "https://app.developershub.jp,http://localhost:5173",
    DEFAULT_MAX_BODY_BYTES: "1048576",
    FILES_MAX_BODY_BYTES: "26214400",
    TURNSTILE_SECRET: "test-secret",
  };
  return { ...base, ...overrides };
}
