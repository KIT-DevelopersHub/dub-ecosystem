// Hono app — a thin HTTP adapter over MemberService. The gateway strips API_PREFIX
// and forwards /members/* to this Worker. Read = identity:read; write = identity:admin
// (運営メンバー管理 is an org-people administration surface — it reuses the identity
// permission gates rather than introducing new catalog keys).
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, DUB_HEADERS, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import type { member } from "@dub/types";
import type { AppDeps } from "./types";
import { MemberService, type ReqCtx } from "./service";

// Actor stamped on a 参加届 that arrives through the public (unauthenticated) path.
// The gateway forwards it as a genuine service-to-service call (x-dub-internal), but
// there is no signed-in user, so submissions are attributed to this system principal.
const PUBLIC_PARTICIPATION_ACTOR = "system:public-participation";

function reqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = ctx?.userId ?? c.req.header("x-dub-user-id");
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId, userId };
}

// Like reqCtx, but for the public (unauthenticated) internal route: no signed-in user,
// so attribute the 参加届 to the system principal instead of 401ing.
function internalReqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = ctx?.userId ?? c.req.header("x-dub-user-id") ?? PUBLIC_PARTICIPATION_ACTOR;
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

  // ---- internal-only guard: /members/internal/* requires the x-dub-internal marker.
  // The gateway strips all x-dub-* off external requests (spoof-defense), so only genuine
  // service-to-service calls carry it; external callers get a 404 (route never exposed).
  app.use("/members/internal/*", async (c, next) => {
    if (!c.req.header(DUB_HEADERS.internal)) throw errors.notFound("route", c.req.path);
    await next();
  });

  // Public 参加届 (unauthenticated at the edge): the gateway's /public/participation
  // handler verifies Turnstile / rate-limits, then forwards here with a system actor.
  // No requireAuth — the internal guard above is the only gate. Roster write is the same
  // non-destructive resolve as the authenticated path.
  app.post("/members/internal/participation", async (c) => {
    const body = await readJson<member.SubmitParticipationRequest>(c);
    return c.json(await svc.submitParticipation(internalReqCtx(c), body), 201);
  });

  // Auth for the rest of /members/*. The public internal route above is handled before
  // this runs, so exclude it here (it must not require a signed-in user).
  app.use("/members/*", async (c, next) => {
    if (c.req.path.startsWith("/members/internal/")) return next();
    return authz.requireAuth()(c, next);
  });

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

  // ---- identity linking (#1) ----
  // Reverse lookup FIRST so the literal segment isn't shadowed by /people/:id/... routes.
  app.get("/members/people/by-identity/:identityUserId", authz.requirePermission(READ), async (c) => {
    const member = await svc.getByIdentityUserId(reqCtx(c), c.req.param("identityUserId"));
    return c.json({ member });
  });
  app.post("/members/people/:id/identity-link", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.LinkIdentityRequest>(c);
    return c.json(await svc.linkIdentity(reqCtx(c), c.req.param("id"), body));
  });
  app.patch("/members/people/:id", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.UpdateMemberRequest>(c);
    return c.json(await svc.updateMember(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/people/:id", authz.requirePermission(WRITE), async (c) => {
    await svc.deleteMember(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  // 物理削除(完全削除・不可逆): status="deleted" の行のみ許可 (それ以外は 409)。
  app.delete("/members/people/:id/purge", authz.requirePermission(WRITE), async (c) => {
    await svc.hardDeleteMember(reqCtx(c), c.req.param("id"));
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
  // 突合候補 (招待中/検討中のうち氏名/メール一致) — 管理者が結合先を選ぶために閲覧。
  app.get("/members/participation/:id/candidates", authz.requirePermission(READ), async (c) => {
    return c.json(await svc.listParticipationCandidates(reqCtx(c), c.req.param("id")));
  });
  // 反映確定 (link/create/skip) — roster を書き換えるので identity:admin。
  app.post("/members/participation/:id/resolve", authz.requirePermission(WRITE), async (c) => {
    const body = await readJson<member.ResolveParticipationRequest>(c);
    return c.json(await svc.resolveParticipation(reqCtx(c), c.req.param("id"), body));
  });

  return app;
}
