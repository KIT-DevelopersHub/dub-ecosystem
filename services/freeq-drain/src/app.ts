// Minimal HTTP surface. A Worker needs a default export with a fetch handler; freeq-drain
// does its real work in the DO alarm (src/drain-do.ts), so fetch serves only a health probe
// and the one-shot POST /internal/drain/kick that arms the DO alarm after a deploy.
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import { Hono } from "hono";
import type { Env } from "./env";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/internal/health", (c) => c.json({ ok: true, service: "freeq-drain" }));
  app.get("/", (c) => c.text("freeq-drain"));

  // Bootstrap the DO alarm loop. Idempotent (ensureAlarm only sets an alarm when none is
  // pending), so it is safe to call after every deploy. Guarded by the x-dub-internal
  // Service-Binding marker — never reachable from the public internet (workers_dev = false).
  app.post("/internal/drain/kick", async (c) => {
    if (c.req.header(HDR_INTERNAL) !== INTERNAL_HEADER_VALUE) return c.json({ error: "forbidden" }, 403);
    const ns = c.env.DRAIN_DO;
    if (!ns) return c.json({ error: "DRAIN_DO not bound" }, 503);
    const stub = ns.get(ns.idFromName("singleton"));
    const res = await stub.fetch("https://freeq-drain-do/internal/ensure-alarm", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as unknown;
    return c.json({ ok: true, kicked: true, do: body });
  });

  return app;
}
