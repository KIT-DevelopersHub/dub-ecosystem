// Frontend health = "can each app page actually open?". Since fe2 is a single SPA (client-side
// routing, SPA fallback), every app route serves the same index.html; the real risk — and the
// incident that motivated this monitor — is a STALE/MISSING JS chunk: a deploy lands index.html
// but not all of its hashed chunks, so navigating an app throws "something went wrong".
//
// Everything is probed over the SVC_FE Service Binding (NOT public fetch — a same-account
// workers.dev subrequest loops back to 404; see checks.ts).
//
// Strategy (HTTP only, no headless browser — per the requirement):
//   1. ONE asset sweep: GET /app-health.json (build-emitted list of every JS/CSS chunk the SPA
//      ships) and probe each asset exists (200). A single 404 here breaks the whole SPA.
//   2. Per-app row: GET the app's route (SPA fallback => 200 + real HTML). Its health = the
//      route loads AND the shared asset sweep passed. This yields アプリ単位 rows (events / mail
//      / gantt / …) while the underlying stale-chunk guard is computed once.
import type { Fetcher } from "@cloudflare/workers-types";
import { probeBinding } from "./checks";
import { FRONTEND_APPS, APP_HEALTH_MANIFEST_PATH } from "./config";
import type { Env } from "./env";
import type { TargetResult } from "./types";

interface AssetSweep {
  ok: boolean;
  detail: string; // "all N chunks present" | "chunk missing: /assets/x.js (HTTP 404); …"
}

interface AppHealthManifest {
  generatedAt?: string;
  assets?: unknown;
}

/** GET /app-health.json (over the SVC_FE binding) and probe every listed asset. A missing
 *  manifest is itself a failure (the build/deploy didn't ship it), reported distinctly. */
export async function sweepAssets(fe: Fetcher): Promise<AssetSweep> {
  let manifest: AppHealthManifest;
  try {
    const res = await (fe as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request(`https://svc${APP_HEALTH_MANIFEST_PATH}`),
    );
    if (res.status !== 200) return { ok: false, detail: `app-health.json HTTP ${res.status}` };
    manifest = (await res.json()) as AppHealthManifest;
  } catch (err) {
    return { ok: false, detail: `app-health.json unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const assets = Array.isArray(manifest.assets) ? (manifest.assets as unknown[]).filter((a): a is string => typeof a === "string") : [];
  if (assets.length === 0) return { ok: false, detail: "app-health.json has no assets listed" };

  const missing: string[] = [];
  for (const asset of assets) {
    const path = asset.startsWith("/") ? asset : `/${asset}`;
    // HEAD first (cheap); some asset servers 405 HEAD, so fall back to GET on non-200/404.
    let out = await probeBinding(fe, path, { method: "HEAD" });
    if (!out.ok && !/HTTP 404/.test(out.detail)) out = await probeBinding(fe, path, { method: "GET" });
    if (!out.ok) missing.push(`${asset} (${out.detail.match(/HTTP \d+/)?.[0] ?? "fail"})`);
  }
  if (missing.length > 0) {
    return { ok: false, detail: `${missing.length}/${assets.length} chunk(s) missing: ${missing.slice(0, 5).join(", ")}` };
  }
  return { ok: true, detail: `all ${assets.length} chunks present` };
}

/** Produce one TargetResult per frontend app (id = "fe:<appId>"). */
export async function checkFrontend(env: Env): Promise<TargetResult[]> {
  const fe = env.SVC_FE;
  if (!fe) {
    return FRONTEND_APPS.map((app) => ({
      id: `fe:${app.id}`,
      kind: "frontend" as const,
      label: `画面: ${app.label}`,
      status: "down" as const,
      detail: "SVC_FE binding not bound",
    }));
  }
  const sweep = await sweepAssets(fe);

  const results: TargetResult[] = [];
  for (const app of FRONTEND_APPS) {
    // SPA fallback returns index.html for every route; require real HTML (the app mount point).
    const route = await probeBinding(fe, app.route, { bodyIncludes: `id="root"` });
    const ok = route.ok && sweep.ok;
    const detail = !route.ok ? route.detail : !sweep.ok ? sweep.detail : `route+chunks ok (${sweep.detail})`;
    results.push({ id: `fe:${app.id}`, kind: "frontend", label: `画面: ${app.label}`, status: ok ? "ok" : "down", detail });
  }
  return results;
}
