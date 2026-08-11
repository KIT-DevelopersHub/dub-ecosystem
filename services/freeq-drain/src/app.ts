// Minimal HTTP surface. A Worker needs a default export with a fetch handler; freeq-drain
// does its real work in scheduled(), so fetch only serves a trivial health probe.
import { Hono } from "hono";
import type { Env } from "./env";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/internal/health", (c) => c.json({ ok: true, service: "freeq-drain" }));
  app.get("/", (c) => c.text("freeq-drain"));
  return app;
}
