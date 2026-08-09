// Internal-only HTTP surface (Hono). Every route requires x-dub-internal (else 404,
// gateway internalOnly parity) + trusted-header auth + a mail:read/mail:admin check.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { DubError, dubErrorHandler, errors } from "@dub/errors";
import { DUB_HEADERS, dubContext, type RequestContext } from "@dub/http";
import { getUserId, type AuthClient } from "@dub/auth-client";
import type { PipelineDeps } from "./pipeline";
import { dryRun, processInbound } from "./pipeline";
import type { RunContext } from "./publisher";
import { validateRuleShape } from "./rules";
import { ruleReferencesMissingTemplate, ruleNotFound, templateNotFound } from "./errors";
import type {
  CreateRuleInput,
  CreateTemplateInput,
  DecisionFilter,
  DryRunRequest,
  ProcessRequest,
  RuleFilter,
  UpdateRuleInput,
  UpdateTemplateInput,
} from "./types";

export interface AppDeps {
  pipeline: PipelineDeps;
  authClient: AuthClient;
}

function runOf(c: Context): RunContext {
  const dubCtx = c.get("dubCtx") as RequestContext;
  return { requestId: dubCtx.requestId, actorId: getUserId(c) };
}

async function jsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

/** Reject non-internal callers (presence-only x-dub-internal marker). */
const internalOnly: MiddlewareHandler = async (c, next) => {
  if (!c.req.header(DUB_HEADERS.internal)) throw errors.notFound("route");
  await next();
};

export function createApp(deps: AppDeps) {
  const { pipeline, authClient } = deps;
  const repo = pipeline.repo;
  const app = new Hono();

  app.onError(dubErrorHandler({ service: "mail-automation" }));

  // downstream service: require x-dub-request-id (no minting), then internal + auth.
  app.use("*", dubContext({ allowGenerate: false }));
  app.use("*", internalOnly);
  app.use("*", authClient.requireAuth());

  const read = authClient.requirePermission("mail:read");
  const admin = authClient.requirePermission("mail:admin");

  // ---- rules ----
  app.get("/rules", read, async (c) => {
    const filter: RuleFilter = {};
    const enabled = c.req.query("enabled");
    if (enabled !== undefined) filter.enabled = enabled === "true";
    const eventId = c.req.query("eventId");
    if (eventId !== undefined) filter.eventId = eventId;
    const items = await repo.listRules(filter);
    return c.json({ items, nextCursor: null });
  });

  app.post("/rules", admin, async (c) => {
    const input = await jsonBody<CreateRuleInput>(c);
    validateRuleShape(input.conditions, input.action);
    if (input.action.type === "reply") {
      const tpl = await repo.getTemplate(input.action.templateId);
      if (!tpl) throw ruleReferencesMissingTemplate(input.action.templateId);
    }
    const rule = await repo.createRule(input, getUserId(c));
    return c.json(rule, 201);
  });

  app.get("/rules/:id", read, async (c) => {
    const rule = await repo.getRule(c.req.param("id"));
    if (!rule) throw ruleNotFound(c.req.param("id"));
    return c.json(rule);
  });

  app.patch("/rules/:id", admin, async (c) => {
    const patch = await jsonBody<UpdateRuleInput>(c);
    if (patch.conditions && patch.action) validateRuleShape(patch.conditions, patch.action);
    if (patch.action?.type === "reply") {
      const tpl = await repo.getTemplate(patch.action.templateId);
      if (!tpl) throw ruleReferencesMissingTemplate(patch.action.templateId);
    }
    const rule = await repo.updateRule(c.req.param("id"), patch);
    if (!rule) throw ruleNotFound(c.req.param("id"));
    return c.json(rule);
  });

  app.delete("/rules/:id", admin, async (c) => {
    const ok = await repo.softDeleteRule(c.req.param("id"));
    if (!ok) throw ruleNotFound(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- templates ----
  app.get("/templates", read, async (c) => {
    return c.json({ items: await repo.listTemplates(), nextCursor: null });
  });
  app.post("/templates", admin, async (c) => {
    const input = await jsonBody<CreateTemplateInput>(c);
    if (!input.name || !input.subject || !input.body) {
      throw errors.validationFailed([{ field: "template", reason: "name_subject_body_required" }]);
    }
    return c.json(await repo.createTemplate(input), 201);
  });
  app.patch("/templates/:id", admin, async (c) => {
    const patch = await jsonBody<UpdateTemplateInput>(c);
    const tpl = await repo.updateTemplate(c.req.param("id"), patch);
    if (!tpl) throw templateNotFound(c.req.param("id"));
    return c.json(tpl);
  });

  // ---- process / dry-run ----
  app.post("/process", admin, async (c) => {
    const body = await jsonBody<ProcessRequest>(c);
    if (!body.mail?.id) throw errors.validationFailed([{ field: "mail.id", reason: "required" }]);
    const res = await processInbound(pipeline, body.mail, { force: body.force ?? false }, runOf(c));
    return c.json(res);
  });

  app.post("/dry-run", read, async (c) => {
    const body = await jsonBody<DryRunRequest>(c);
    if (!body.mail?.id) throw errors.validationFailed([{ field: "mail.id", reason: "required" }]);
    return c.json(await dryRun(pipeline, body.mail, runOf(c)));
  });

  // ---- decisions ----
  app.get("/decisions", read, async (c) => {
    const filter: DecisionFilter = {};
    const messageId = c.req.query("messageId");
    if (messageId) filter.messageId = messageId;
    const ruleId = c.req.query("ruleId");
    if (ruleId) filter.ruleId = ruleId;
    const outcome = c.req.query("outcome");
    if (outcome) filter.outcome = outcome as DecisionFilter["outcome"];
    const limit = c.req.query("limit");
    if (limit) filter.limit = Number(limit);
    return c.json({ items: await repo.listDecisions(filter), nextCursor: null });
  });

  // ---- settings (kill switch) ----
  app.get("/settings", read, async (c) => c.json(await repo.getSettings()));
  app.patch("/settings", admin, async (c) => {
    const patch = await jsonBody<Partial<import("./types").AutomationSettings>>(c);
    return c.json(await repo.updateSettings(patch, getUserId(c)));
  });

  // guard against unexpected re-throw of non-Dub errors is handled by onError
  app.notFound(() => {
    throw new DubError("NOT_FOUND", "route not found", { status: 404 });
  });

  return app;
}
