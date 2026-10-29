// Pure logic for the retired-version redirect Worker (worker/legacy-redirect-worker.ts).
// No runtime imports so it runs under both workerd and `node --test`.

export const CURRENT_LP_ORIGIN = "https://hokuriku-it-conf.com";

/** Same path + query on the current LP. */
export function redirectTarget(requestUrl: string, target: string = CURRENT_LP_ORIGIN): string {
  const from = new URL(requestUrl);
  return new URL(from.pathname + from.search, target).toString();
}

/** Permanent (301) redirect to the current LP. */
export function legacyRedirect(request: Request): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: redirectTarget(request.url), "Cache-Control": "public, max-age=3600" },
  });
}
