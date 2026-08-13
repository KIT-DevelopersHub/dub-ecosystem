// Hono app — a thin HTTP adapter over MemberService. The gateway strips API_PREFIX
// and forwards /members/* to this Worker. Read = identity:read; write = identity:admin
// (運営メンバー管理 is an org-people administration surface — it reuses the identity
// permission gates rather than introducing new catalog keys).
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import type { member } from "@dub/types";
import type { AppDeps } from "./types";
import { MemberService, type ReqCtx } from "./service";

function reqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = ctx?.userId ?? c.req.header("x-dub-user-id");
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId, userId };
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono {
  const svc = new MemberService(deps);
  const app = new Hono();

  app.onError(dubErrorHandler({ service: "member-service" }));
  app.use("*", dubContext({ allowGenerate: true }));

  app.get("/health", (c) => c.json({ status: "ok", service: "member-service" }));

  const { authz } = deps;
  const READ = "identity:read" as const;
  const WRITE = "identity:admin" as const;

  app.use("/members/*", authz.requireAuth());

  // ---- overview (all three views) ----
  app.get("/members/overview", authz.requirePermission(READ), async (c) => {
    return c.json(await svc.getOverview(reqCtx(c)));
  });

  // ---- teams ----
  // GET /members/teams is the CANONICAL team list other apps (e.g. gantt) read to
  // source their own team switchers ({ teams: Team[] }).
  app.get("/members/teams", authz.requirePermission(READ), async (c) => {
    return c.json(await svc.listTeams(reqCtx(c)));
  });
  app.post("/members/teams", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.CreateTeamRequest>(c);
    return c.json(await svc.createTeam(reqCtx(c), body), 201);
  });
  app.patch("/members/teams/:id", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.UpdateTeamRequest>(c);
    return c.json(await svc.updateTeam(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/teams/:id", authz.requirePermission(WRITE), async (c) => {
    await svc.deleteTeam(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- people ----
  app.post("/members/people", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.CreateMemberRequest>(c);
    return c.json(await svc.createMember(reqCtx(c), body), 201);
  });
  app.patch("/members/people/:id", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.UpdateMemberRequest>(c);
    return c.json(await svc.updateMember(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/people/:id", authz.requirePermission(WRITE), async (c) => {
    await svc.deleteMember(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- 参加届 (participation) ----
  // Submit is open to any authenticated 運営 (they file their own 届, which self-
  // registers/promotes them on the roster). The admin list is gated by identity:read.
  app.post("/members/participation", async (c) => {
    const body = await readJson<member.SubmitParticipationRequest>(c);
    return c.json(await svc.submitParticipation(reqCtx(c), body), 201);
  });
  app.get("/members/participation", authz.requirePermission(READ), async (c) => {
    return c.json(await svc.listParticipations(reqCtx(c)));
  });

  return app;
}
