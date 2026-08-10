// Transparent proxy to Service Bindings. Preserves method/body/query; strips ALL
// inbound x-dub-* (anti-spoofing) and re-adds only the trusted set. Crucially it
// NEVER sets x-dub-internal on forwarded external requests — that marker is reserved
// for genuine service-to-service calls and gates internal-only endpoints.
import type { Fetcher } from "@cloudflare/workers-types";
import { DUB_HEADERS } from "@dub/http";
import { errors } from "@dub/errors";

const FORWARD_BASE = "https://svc";
const DEFAULT_TIMEOUT_MS = 15_000;
const BODYLESS = new Set(["GET", "HEAD"]);

export interface ForwardParams {
  requestId: string;
  userId?: string;
  timeoutMs?: number;
}

/** Copy incoming headers minus anything the gateway owns or that must not leak downstream. */
function sanitizeHeaders(incoming: Headers, params: ForwardParams): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith("x-dub-")) return; // strip all trusted headers (spoof defense)
    if (k === "host" || k === "authorization" || k === "cookie") return; // token stays at the edge
    if (k === "content-length") return; // recomputed by the runtime
    out.set(key, value);
  });
  out.set(DUB_HEADERS.requestId, params.requestId);
  out.set(DUB_HEADERS.caller, "api-gateway");
  if (params.userId) out.set(DUB_HEADERS.userId, params.userId);
  // DUB_HEADERS.internal is intentionally NOT set here.
  return out;
}

/** Forward one request to a binding. Timeout -> 504, transport failure -> 502. */
export async function forwardRequest(
  binding: Fetcher,
  internalPath: string,
  original: Request,
  params: ForwardParams,
): Promise<Response> {
  const src = new URL(original.url);
  const url = FORWARD_BASE + internalPath + src.search;
  const headers = sanitizeHeaders(original.headers, params);

  const method = original.method.toUpperCase();
  const body = BODYLESS.has(method) ? undefined : await original.clone().arrayBuffer();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const req = new Request(url, {
      method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      signal: ac.signal,
      // Do NOT follow downstream redirects at the edge: the OAuth callback returns
      // a 302 (+ Set-Cookie) that must reach the browser verbatim. "follow" would
      // consume it server-side, dropping the session cookie and breaking login.
      redirect: "manual",
    });
    const fetcher = binding as unknown as { fetch: (r: Request) => Promise<Response> };
    const res = await fetcher.fetch(req);
    return res; // passthrough: downstream status/code preserved (incl. 403)
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw aborted ? errors.upstreamTimeout("upstream", err) : errors.upstreamUnavailable("upstream", err);
  } finally {
    clearTimeout(timer);
  }
}
