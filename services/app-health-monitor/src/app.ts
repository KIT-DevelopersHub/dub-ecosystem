// app-health-monitor HTTP surface (Hono). The real polling runs in the MonitorDO alarm
// (monitor-do.ts); fetch serves:
//   - GET  /internal/health              liveness (public)
//   - POST /internal/monitor/kick        arm the DO hourly-alarm loop (token-gated)
//   - POST /internal/monitor/run         run one poll cycle now, returns the summary (token-gated)
//   - GET  /internal/monitor/status      latest per-target snapshot from D1 (token-gated)
// SECURITY: this Worker has workers_dev enabled (public origin) so CI can arm/trigger it. On a
// public origin the x-dub-internal marker is NOT a trust signal — anyone can send it (it only
// protects the internal, workers_dev=false services because the gateway strips x-dub-* off
// external traffic). So the control routes are gated ONLY by a matching `x-monitor-token`
// (env.MONITOR_ADMIN_TOKEN). Fail-closed: if the secret is unset, control routes are denied
// (arm locally via wrangler instead). Only GET /internal/health + GET / are public.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { errors, dubErrorHandler } from "@dub/errors";
import type { Env } from "./env";
import { SERVICE_NAME, feOrigin } from "./config";
import { probeHttp } from "./checks";
import { createD1Repo } from "./repo";
import { createNotifier } from "./notify";
import { runCheckCycle } from "./monitor";
import type { TargetResult } from "./types";

type AppBindings = { Bindings: Env };

// Authorize a control route with the shared admin token only. Constant-time-ish compare via a
// length+equality check (tokens are high-entropy secrets; this is not a password oracle path).
const gate: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = c.env.MONITOR_ADMIN_TOKEN;
  const presented = c.req.header("x-monitor-token");
  if (!token) throw errors.forbidden("control routes disabled: MONITOR_ADMIN_TOKEN unset");
  if (!presented || presented !== token) throw errors.forbidden("invalid x-monitor-token");
  return next();
};

/** Build a synthetic probe target to prove the down->alert->recovery pipeline live.
 *  down = probe a guaranteed-missing chunk (404); up = probe the real SPA root (200). Same id
 *  so state transitions across successive /run calls. */
async function syntheticTarget(env: Env, mode: "down" | "up"): Promise<TargetResult> {
  const origin = feOrigin(env);
  if (mode === "down") {
    const out = await probeHttp(`${origin}/__healthmonitor_synthetic_missing_chunk__.js`, { expectStatus: 200 });
    return { id: "synthetic:probe", kind: "service", label: "(合成テスト) 死活監視パイプライン", status: out.ok ? "ok" : "down", detail: `合成: 存在しないチャンクの模擬 -> ${out.detail}` };
  }
  const out = await probeHttp(`${origin}/`, { expectStatus: 200 });
  return { id: "synthetic:probe", kind: "service", label: "(合成テスト) 死活監視パイプライン", status: out.ok ? "ok" : "down", detail: `合成: 復旧確認 -> ${out.detail}` };
}

export function createApp() {
  const app = new Hono<AppBindings>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));
  app.get("/", (c) => c.text("app-health-monitor"));

  // ---- bootstrap the DO hourly-alarm loop (idempotent). ----
  app.post("/internal/monitor/kick", gate, async (c) => {
    const ns = c.env.MONITOR_DO;
    if (!ns) return c.json({ error: "MONITOR_DO not bound" }, 503);
    const stub = ns.get(ns.idFromName("singleton"));
    const res = await stub.fetch("https://app-health-monitor-do/internal/ensure-alarm", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as unknown;
    return c.json({ ok: true, kicked: true, do: body });
  });

  // ---- run one poll cycle NOW. ?inject=down|up appends a synthetic target for live proof. ----
  app.post("/internal/monitor/run", gate, async (c) => {
    if (!c.env.DB) return c.json({ error: "DB not bound" }, 503);
    const inject = c.req.query("inject");
    const extraTargets: TargetResult[] = [];
    if (inject === "down" || inject === "up") extraTargets.push(await syntheticTarget(c.env, inject));

    const repo = createD1Repo(c.env.DB);
    const notifier = createNotifier(c.env);
    const summary = await runCheckCycle(c.env, repo, notifier, { extraTargets });
    return c.json(summary);
  });

  // ---- latest snapshot (admin visibility / history). ----
  app.get("/internal/monitor/status", gate, async (c) => {
    if (!c.env.DB) return c.json({ error: "DB not bound" }, 503);
    const repo = createD1Repo(c.env.DB);
    const statuses = await repo.listStatuses();
    return c.json({ generatedAt: new Date().toISOString(), count: statuses.length, statuses });
  });

  return app;
}

// re-export so index.ts's typing stays local.
export type { Context };
