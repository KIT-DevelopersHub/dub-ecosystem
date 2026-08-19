// Low-level probes. Every probe RESOLVES a {ok, detail} — it never throws — so one bad target
// can't abort the cycle. "ok" requires the expected HTTP status; a 404/5xx/timeout/unbound all
// resolve to a described failure.
//
// IMPORTANT: everything is probed over SERVICE BINDINGS, never public `fetch` to a workers.dev
// origin. Two reasons learned in prod: (1) same-account Worker-to-Worker subrequests over
// workers.dev do NOT resolve like an external client (they 404), and (2) services running
// `dubContext({ allowGenerate:false })` reject a request with no x-dub-request-id (400). So the
// probe attaches the full x-dub-* set (request-id + caller + internal marker) that a genuine
// service-to-service call carries.
import { HEADERS } from "@dub/observability";
import { newRequestId } from "@dub/http";
import type { Fetcher } from "@cloudflare/workers-types";
import { PROBE_TIMEOUT_MS, SERVICE_NAME } from "./config";

export type Health = "ok" | "down";

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

/** fetch() with an AbortController timeout. Resolves the Response (incl. 4xx/5xx — fetch only
 *  throws on network error); rejects on network failure / timeout so callers catch uniformly. */
async function timedFetch(
  doFetch: (req: Request) => Promise<Response>,
  req: Request,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Re-issue with the abort signal (Request is immutable re: signal once constructed elsewhere).
    const withSignal = new Request(req, { signal: ac.signal });
    return await doFetch(withSignal);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeOpts {
  expectStatus?: number;
  bodyIncludes?: string; // when set (and method !== HEAD), the body must contain this substring
  method?: "GET" | "HEAD";
  timeoutMs?: number;
}

/** Service-Binding probe. Attaches the x-dub-* set a genuine service-to-service call carries
 *  (request-id so allowGenerate:false services accept it; caller; internal marker for /internal/*
 *  routes). Expects `expectStatus` (default 200). An unbound fetcher resolves to a described
 *  failure (never throws). Works for backend services, the gateway, AND the fe2 assets worker. */
export async function probeBinding(fetcher: Fetcher | undefined, path: string, opts: ProbeOpts = {}): Promise<ProbeOutcome> {
  if (!fetcher) return { ok: false, detail: `service binding not bound (${path})` };
  const expect = opts.expectStatus ?? 200;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const req = new Request(`https://svc${path}`, {
      method: opts.method ?? "GET",
      headers: {
        [HEADERS.internal]: "1",
        [HEADERS.requestId]: newRequestId(),
        [HEADERS.caller]: SERVICE_NAME,
      },
    });
    const res = await timedFetch(
      (r) => (fetcher as unknown as { fetch: (x: Request) => Promise<Response> }).fetch(r),
      req,
      timeoutMs,
    );
    if (res.status !== expect) return { ok: false, detail: `HTTP ${res.status} (expected ${expect}) ${path}` };
    if (opts.bodyIncludes && opts.method !== "HEAD") {
      const text = await res.text();
      if (!text.includes(opts.bodyIncludes)) return { ok: false, detail: `body missing marker "${opts.bodyIncludes}" ${path}` };
    }
    return { ok: true, detail: `HTTP ${res.status} ${path}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, detail: `${aborted ? "timeout" : "binding error"}: ${errMsg(err)} ${path}` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
