// Hono app: Commander phase-gate API over the shared dub-core D1 (commander_ ns).
//   GET  /health
//   GET  /features                       -> FeatureRow[]
//   POST /features                       -> create ({ title, ledgerRef? })
//   GET  /features/:id                   -> { feature, allowedTransitions, transitions }
//   POST /features/:id/transition        -> phase gate ({ to, approvedByUser?, note? })
//   GET  /features/:id/tasks             -> TaskRow[]
//   POST /features/:id/tasks             -> create task ({ title, status? })
//
// The gate: `to` not on an allowed edge => 409 (段飛ばし禁止); an approval-required
// edge without approvedByUser:true => 403 (自己承認禁止). See @dub/commander-phases.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { allowedTransitions } from "@dub/commander-phases";
import type { AppBindings } from "./env";
import {
  createFeature,
  listFeatures,
  getFeature,
  listTransitions,
  transitionFeature,
  createTask,
  listTasks,
} from "./repo";

export function createApp() {
  const app = new Hono<AppBindings>();

  // The Dub-hosted / local commander web SPA calls this API cross-origin.
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  // Optional operator-token guard on mutations (see env.ts). Off when unset.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const expected = c.env.COMMANDER_OPERATOR_TOKEN;
      if (expected && c.req.header("x-commander-token") !== expected) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({ ok: true, service: "commander-service", version: "0.1.0" }),
  );

  app.get("/features", async (c) => {
    return c.json({ features: await listFeatures(c.env.DB) });
  });

  app.post("/features", async (c) => {
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title === "" || title.length > 200) {
      return c.json({ error: "title_required" }, 400);
    }
    const ledgerRef = typeof body?.ledgerRef === "string" ? body.ledgerRef : null;
    const feature = await createFeature(c.env.DB, { title, ledgerRef });
    return c.json({ feature }, 201);
  });

  app.get("/features/:id", async (c) => {
    const id = c.req.param("id");
    const feature = await getFeature(c.env.DB, id);
    if (!feature) return c.json({ error: "feature_not_found" }, 404);
    return c.json({
      feature,
      allowedTransitions: allowedTransitions(feature.phase),
      transitions: await listTransitions(c.env.DB, id),
    });
  });

  app.post("/features/:id/transition", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const to = typeof body?.to === "string" ? body.to : "";
    const approvedByUser = body?.approvedByUser === true;
    const note = typeof body?.note === "string" ? body.note : null;

    const outcome = await transitionFeature(c.env.DB, id, to, { approvedByUser, note });
    if (outcome.ok) {
      return c.json({ feature: outcome.feature, transition: outcome.transition });
    }
    switch (outcome.code) {
      case "not_found":
        return c.json({ error: "feature_not_found" }, 404);
      case "invalid_phase":
        return c.json({ error: "invalid_phase", to }, 400);
      case "illegal_transition":
        return c.json(
          { error: "illegal_transition", message: outcome.message },
          outcome.httpStatus, // 409
        );
      case "approval_required":
        return c.json(
          { error: "approval_required", message: outcome.message },
          outcome.httpStatus, // 403
        );
    }
  });

  app.get("/features/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const feature = await getFeature(c.env.DB, id);
    if (!feature) return c.json({ error: "feature_not_found" }, 404);
    return c.json({ tasks: await listTasks(c.env.DB, id) });
  });

  app.post("/features/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title === "" || title.length > 200) {
      return c.json({ error: "title_required" }, 400);
    }
    const status = body?.status;
    const task = await createTask(c.env.DB, id, {
      title,
      status: status === "doing" || status === "done" ? status : "todo",
    });
    if (!task) return c.json({ error: "feature_not_found" }, 404);
    return c.json({ task }, 201);
  });

  return app;
}
