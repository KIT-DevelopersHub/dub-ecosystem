// x-dub-* context: constants (re-exported from observability), extraction, minting.
import type { MiddlewareHandler } from "hono";
import { DubError } from "@dub/errors";
import { HDR_REQUEST_ID, HDR_USER_ID, HDR_CALLER, HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";

export const DUB_HEADERS = {
  requestId: HDR_REQUEST_ID, // "x-dub-request-id"
  userId: HDR_USER_ID, // "x-dub-user-id" (trusted, verified once at the entrypoint)
  caller: HDR_CALLER, // "x-dub-caller"
  internal: HDR_INTERNAL, // "x-dub-internal": presence-only "1"
} as const;
// x-dub-org-id / x-dub-roles: REMOVED (theme6). Authz via identity /authz/check.

export const INTERNAL_MARKER = INTERNAL_HEADER_VALUE;

export interface RequestContext {
  requestId: string;
  userId?: string; // absent = unauthenticated / system-origin (cron, webhook)
  caller?: string;
}

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
type RandomSource = { getRandomValues?: (a: Uint8Array) => Uint8Array };
function randomChar(): string {
  const g = (globalThis as { crypto?: RandomSource }).crypto;
  let n: number;
  if (g && typeof g.getRandomValues === "function") {
    const b = new Uint8Array(1);
    g.getRandomValues(b);
    n = b[0] as number;
  } else {
    n = Math.floor(Math.random() * 256);
  }
  return ENCODING[n % ENCODING.length]!;
}

/** ULID; the ONLY requestId mint. Entrypoints only (gateway/MO3/webhook-ingest/cron). */
export function newRequestId(): string {
  let time = "";
  let t = Date.now();
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    time = ENCODING[mod]! + time;
    t = (t - mod) / 32;
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += randomChar();
  return time + rand;
}

/** Read incoming headers into a context. Absence of requestId is a contract
 *  violation unless allowGenerate is set (entrypoints only). */
export function extractContext(headers: Headers, opts?: { allowGenerate?: boolean }): RequestContext {
  const requestId = headers.get(DUB_HEADERS.requestId);
  const userId = headers.get(DUB_HEADERS.userId) ?? undefined;
  const caller = headers.get(DUB_HEADERS.caller) ?? undefined;
  if (!requestId) {
    if (opts?.allowGenerate) {
      return { requestId: newRequestId(), ...(userId ? { userId } : {}), ...(caller ? { caller } : {}) };
    }
    throw new DubError("HTTP_CONTEXT_MISSING", "x-dub-request-id header is absent", { status: 400 });
  }
  return { requestId, ...(userId ? { userId } : {}), ...(caller ? { caller } : {}) };
}

/** Hono middleware: the ONLY x-dub-* parser. Stores context at c.get("dubCtx"). */
export function dubContext(opts?: { allowGenerate?: boolean }): MiddlewareHandler {
  return async (c, next) => {
    const ctx = extractContext(c.req.raw.headers, opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set("dubCtx", ctx);
    await next();
  };
}
