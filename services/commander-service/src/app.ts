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
  listBoard,
  createFeatureTask,
  updateTaskStatus,
  createRun,
  getRun,
  listRuns,
  listRunEvents,
  appendRunEvent,
  isRunEventType,
  backfillTaskUrls,
  isChatKind,
  createChatSession,
  listChatSessions,
  getChatSession,
  getChatMessages,
  updateChatSession,
  deleteChatSession,
  addChatMessage,
  updateChatMessage,
  type ChatMessageStatus,
} from "./repo";

export function createApp() {
  const app = new Hono<AppBindings>();

  // The Dub-hosted / local commander web SPA calls this API cross-origin.
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

  // Optional operator-token guard on mutations (see env.ts). Off when unset.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PATCH" || c.req.method === "DELETE") {
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

  // ── Task board (cross-feature) ───────────────────────────────────────────────
  // The Commander home reads the whole workboard here: every task + its feature phase
  // + its latest run status. Lanes (投入待ち/走行中/確認待ち/要修正/完了) are derived web-side.
  app.get("/tasks", async (c) => {
    return c.json({ items: await listBoard(c.env.DB) });
  });

  // "New task" primitive: create a feature + its single task together (1 task = 1
  // feature = 1 worktree). The web then starts a run against the returned taskId.
  app.post("/tasks", async (c) => {
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title === "" || title.length > 200) {
      return c.json({ error: "title_required" }, 400);
    }
    const ledgerRef = typeof body?.ledgerRef === "string" && body.ledgerRef.trim() !== ""
      ? body.ledgerRef.trim()
      : null;
    const created = await createFeatureTask(c.env.DB, { title, ledgerRef });
    return c.json(created, 201);
  });

  // Backfill artifact URLs (P1-2) for tasks whose runs completed before URL capture
  // existed — scans existing run events and folds any demo/staging/PR URLs onto the task.
  app.post("/tasks/backfill-urls", async (c) => {
    return c.json(await backfillTaskUrls(c.env.DB));
  });

  app.patch("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const status = body?.status;
    if (status !== "todo" && status !== "doing" && status !== "done") {
      return c.json({ error: "invalid_status" }, 400);
    }
    const task = await updateTaskStatus(c.env.DB, id, status);
    if (!task) return c.json({ error: "task_not_found" }, 404);
    return c.json({ task });
  });

  // ── Runs (persistence for the local daemon's executions) ─────────────────────
  // The loopback daemon POSTs runs + events here (it cannot reach D1 itself, ADR 0004).
  // POST routes are behind the operator-token guard above.
  app.get("/runs", async (c) => {
    return c.json({ runs: await listRuns(c.env.DB) });
  });

  app.post("/runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    const cwd = typeof body?.cwd === "string" ? body.cwd : "";
    if (prompt.trim() === "" || cwd.trim() === "") {
      return c.json({ error: "prompt_and_cwd_required" }, 400);
    }
    const run = await createRun(c.env.DB, {
      id: typeof body?.id === "string" ? body.id : undefined,
      prompt,
      cwd,
      status: body?.status,
      taskId: typeof body?.taskId === "string" ? body.taskId : null,
    });
    return c.json({ run }, 201);
  });

  app.get("/runs/:id", async (c) => {
    const run = await getRun(c.env.DB, c.req.param("id"));
    if (!run) return c.json({ error: "run_not_found" }, 404);
    return c.json({ run, events: await listRunEvents(c.env.DB, run.id) });
  });

  app.get("/runs/:id/events", async (c) => {
    const run = await getRun(c.env.DB, c.req.param("id"));
    if (!run) return c.json({ error: "run_not_found" }, 404);
    return c.json({ events: await listRunEvents(c.env.DB, run.id) });
  });

  app.post("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (!isRunEventType(body?.type)) {
      return c.json({ error: "invalid_event_type" }, 400);
    }
    const event = await appendRunEvent(c.env.DB, id, {
      type: body.type,
      payload: body?.payload,
      at: typeof body?.at === "string" ? body.at : undefined,
    });
    if (!event) return c.json({ error: "run_not_found" }, 404);
    return c.json({ event }, 201);
  });

  // ── AI chat sessions + messages ("Dubに聞く"/"Dubを操作" history) ──────────────
  // Durable across restarts. DELETE physically removes a session + its messages.
  app.get("/chats", async (c) => {
    const kind = c.req.query("kind");
    if (!isChatKind(kind)) return c.json({ error: "invalid_kind" }, 400);
    return c.json({ sessions: await listChatSessions(c.env.DB, kind) });
  });

  app.post("/chats", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isChatKind(body?.kind)) return c.json({ error: "invalid_kind" }, 400);
    const title = typeof body?.title === "string" ? body.title : "";
    const session = await createChatSession(c.env.DB, { kind: body.kind, title });
    return c.json({ session }, 201);
  });

  app.get("/chats/:id", async (c) => {
    const session = await getChatSession(c.env.DB, c.req.param("id"));
    if (!session) return c.json({ error: "chat_not_found" }, 404);
    return c.json({ session, messages: await getChatMessages(c.env.DB, session.id) });
  });

  app.patch("/chats/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title : undefined;
    const session = await updateChatSession(c.env.DB, c.req.param("id"), { title });
    if (!session) return c.json({ error: "chat_not_found" }, 404);
    return c.json({ session });
  });

  app.delete("/chats/:id", async (c) => {
    const ok = await deleteChatSession(c.env.DB, c.req.param("id"));
    if (!ok) return c.json({ error: "chat_not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/chats/:id/messages", async (c) => {
    const body = await c.req.json().catch(() => null);
    const role = body?.role === "user" || body?.role === "assistant" ? body.role : null;
    if (!role) return c.json({ error: "invalid_role" }, 400);
    const text = typeof body?.text === "string" ? body.text : "";
    const tools = Array.isArray(body?.tools)
      ? body.tools.filter((x: unknown): x is string => typeof x === "string")
      : undefined;
    const status: ChatMessageStatus | undefined =
      body?.status === "streaming" || body?.status === "done" || body?.status === "error"
        ? body.status
        : undefined;
    const message = await addChatMessage(c.env.DB, c.req.param("id"), { role, text, tools, status });
    if (!message) return c.json({ error: "chat_not_found" }, 404);
    return c.json({ message }, 201);
  });

  app.patch("/chats/:id/messages/:mid", async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text : undefined;
    const tools = Array.isArray(body?.tools)
      ? body.tools.filter((x: unknown): x is string => typeof x === "string")
      : undefined;
    const status: ChatMessageStatus | undefined =
      body?.status === "streaming" || body?.status === "done" || body?.status === "error"
        ? body.status
        : undefined;
    const message = await updateChatMessage(c.env.DB, c.req.param("mid"), { text, tools, status });
    if (!message) return c.json({ error: "message_not_found" }, 404);
    return c.json({ message });
  });

  return app;
}
