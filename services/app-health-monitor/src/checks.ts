// Low-level probes. Every probe RESOLVES a {ok, detail} — it never throws — so one bad target
// can't abort the cycle. "ok" requires the expected HTTP status; a 404/5xx/timeout/unbound all
// resolve to a described failure.
import { HEADERS } from "@dub/observability";
import type { Fetcher } from "@cloudflare/workers-types";
import { PROBE_TIMEOUT_MS } from "./config";

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

/** Public-HTTP probe (frontend SPA / gateway). Expects `expectStatus` (default 200) and, when
 *  given, that the body contains `bodyIncludes` (proves real HTML, not an error/empty page). */
export async function probeHttp(
  url: string,
  opts: { expectStatus?: number; bodyIncludes?: string; method?: "GET" | "HEAD"; timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const expect = opts.expectStatus ?? 200;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const req = new Request(url, { method: opts.method ?? "GET", redirect: "manual" });
    const res = await timedFetch((r) => fetch(r as unknown as Request) as unknown as Promise<Response>, req, timeoutMs);
    if (res.status !== expect) {
      return { ok: false, detail: `HTTP ${res.status} (expected ${expect}) ${url}` };
    }
    if (opts.bodyIncludes && opts.method !== "HEAD") {
      const text = await res.text();
      if (!text.includes(opts.bodyIncludes)) {
        return { ok: false, detail: `body missing marker "${opts.bodyIncludes}" ${url}` };
      }
    }
    return { ok: true, detail: `HTTP ${res.status} ${url}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, detail: `${aborted ? "timeout" : "network error"}: ${errMsg(err)} ${url}` };
  }
}

/** Service-Binding probe (backend /health). Attaches the internal marker so /internal/* routes
 *  accept it. Expects 200. An unbound fetcher resolves to a described failure (never throws). */
export async function probeBinding(
  fetcher: Fetcher | undefined,
  path: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  if (!fetcher) return { ok: false, detail: `service binding not bound (${path})` };
  try {
    const req = new Request(`https://svc${path}`, {
      method: "GET",
      headers: { [HEADERS.internal]: "1" },
    });
    const res = await timedFetch(
      (r) => (fetcher as unknown as { fetch: (x: Request) => Promise<Response> }).fetch(r),
      req,
      timeoutMs,
    );
    if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status} (expected 200) ${path}` };
    return { ok: true, detail: `HTTP 200 ${path}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, detail: `${aborted ? "timeout" : "binding error"}: ${errMsg(err)} ${path}` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
