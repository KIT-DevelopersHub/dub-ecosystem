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
  loadBearing?: unknown;
  assets?: unknown;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((a): a is string => typeof a === "string") : [];
}

/** GET /app-health.json (over the SVC_FE binding) and probe the load-bearing chunk set (entry +
 *  per-screen dynamic chunks). Bounded (~1 per screen) so the whole poll stays under the Workers
 *  free-plan 50-subrequest cap. A missing manifest is itself a failure, reported distinctly. */
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
  // Prefer the bounded load-bearing set; fall back to the full asset list for older manifests.
  const chunks = strList(manifest.loadBearing).length > 0 ? strList(manifest.loadBearing) : strList(manifest.assets);
  if (chunks.length === 0) return { ok: false, detail: "app-health.json lists no chunks" };

  const missing: string[] = [];
  for (const asset of chunks) {
    const path = asset.startsWith("/") ? asset : `/${asset}`;
    // HEAD first (cheap); some asset servers 405 HEAD, so fall back to GET on non-200/404.
    let out = await probeBinding(fe, path, { method: "HEAD" });
    if (!out.ok && !/HTTP 404/.test(out.detail)) out = await probeBinding(fe, path, { method: "GET" });
    if (!out.ok) missing.push(`${asset} (${out.detail.match(/HTTP \d+/)?.[0] ?? "fail"})`);
  }
  if (missing.length > 0) {
    return { ok: false, detail: `${missing.length}/${chunks.length} chunk(s) missing: ${missing.slice(0, 5).join(", ")}` };
  }
  return { ok: true, detail: `all ${chunks.length} load-bearing chunks present` };
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
  // The SPA fallback (not_found_handling=single-page-application) serves index.html for EVERY
  // unmatched path, so all app routes return the same shell — probe it ONCE (not once per app)
  // to keep well under the Workers free-plan 50-subrequest cap.
  const shell = await probeBinding(fe, "/", { bodyIncludes: `id="root"` });
  const sweep = await sweepAssets(fe);

  const ok = shell.ok && sweep.ok;
  const detail = !shell.ok ? `SPA shell: ${shell.detail}` : !sweep.ok ? sweep.detail : `shell+chunks ok (${sweep.detail})`;
  // One row per app (アプリ単位). The check is shared (shell + load-bearing chunks), so a missing
  // chunk marks every app down — correct: the whole SPA is broken when its code doesn't resolve.
  return FRONTEND_APPS.map((app) => ({
    id: `fe:${app.id}`,
    kind: "frontend" as const,
    label: `画面: ${app.label}`,
    status: ok ? ("ok" as const) : ("down" as const),
    detail,
  }));
}
