// Hono app — a thin HTTP adapter over MemberService. The gateway strips API_PREFIX
// and forwards /members/* to this Worker. Roster gates are per-app-AUTHORITATIVE:
// read = identity:read OR app:members:view; write = identity:admin OR app:members:edit
// (so 名簿管理 can be delegated to a 統括 role via the per-app toggle in ロール管理,
// without granting full identity:admin). 参加届 (participation) keeps identity:read /
// identity:admin — it is a distinct app surface, not covered by app:members:*.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { dubContext, DUB_HEADERS, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import type { identity, member } from "@dub/types";
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
  // POLICY gates (@dub/types `policy`). This service hosts TWO apps: 運営メンバー (teams /
  // people) and 参加届 (submissions), each with its own row in ロール管理, so a write demands 編集
  // on the app the route belongs to — setting 運営メンバー to 閲覧 stops team/people writes without
  // also freezing 参加届の反映確定, and vice versa (no cross-app escalation).
  //
  // The app's 編集 tier is the WHOLE requirement — deliberately NOT "編集 AND identity:admin".
  // #526 made the per-app key the 正典 so 名簿管理 can be delegated to a 統括 role that holds no
  // org-admin key; re-adding the domain key here would silently revoke that delegation. Roles
  // that could write via identity:admin alone get their `:edit` key from migration 0010, so no
  // one loses access — and from now on setting 運営メンバー to 閲覧 really does stop writes.
  const requireMembersEdit = authz.requireAppAccess("members", "edit");
  const requireParticipationEdit = authz.requireAppAccess("participation", "edit");

  // READS keep the any-of (DOMAIN key OR per-app 閲覧): GET /members/teams is the canonical
  // team list other apps (gantt 等) read, so gating it on the 運営メンバー app alone would break
  // them, while a 統括 role holding only app:members:view must still be able to open the roster.
  //   read  = identity:read OR app:members:view      (write = the 編集 gate above)
  const ROSTER_VIEW = "app:members:view" as const;

  /** Middleware allowing the request iff the caller holds ANY of `keys` (org-wide).
   *  requireAuth has already run, so x-dub-user-id is present. Fail-closed on 401/403. */
  function requireAny(keys: readonly identity.PermissionKey[]): MiddlewareHandler {
    return async (c, next) => {
      const { userId } = reqCtx(c);
      for (const permission of keys) {
        if (await authz.hasPermission(userId, deps.orgId, { permission })) return next();
      }
      throw errors.forbidden(`permission denied: ${keys.join(" | ")}`);
    };
  }
  // Reads keep the any-of (domain key OR per-app 閲覧). Writes no longer use it: every write
  // route now goes through the policy gate above (requireMembersEdit / requireParticipationEdit),
  // which already demands identity:admin AND 編集 on the owning app.
  const rosterRead = requireAny([READ, ROSTER_VIEW]);

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

  // チーム単位メンションの展開 (chat-service → member-service, s2s のみ).
  // ?teamIds=team_a,team_b -> { userIds }: そのチームに属し identity アカウントに
  // リンク済みのメンバー。チャットは投稿者の権限で呼ぶわけではない(通知のための
  // 名簿参照)ので identity:read は課さず、x-dub-internal だけで閉じる。
  app.get("/members/internal/team-members", async (c) => {
    const raw = c.req.query("teamIds") ?? "";
    const teamIds = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return c.json(await svc.listTeamIdentityUserIds(teamIds));
  });

  // Self 参加届 (アカウント設定 → 参加情報). The gateway's GET/POST /api/v1/me/participation
  // authenticates the session, then forwards here as a genuine s2s call (x-dub-internal +
  // the caller's identity x-dub-user-id). Session-scoped to THAT user — no target id, and
  // resolved via the identity link to their member_people row. reqCtx (not internalReqCtx)
  // is used deliberately: a real signed-in user id is required here (not the system actor).
  app.get("/members/internal/me/participation", async (c) => {
    const ctx = reqCtx(c);
    return c.json(await svc.getSelfParticipation(ctx.userId));
  });
  app.post("/members/internal/me/participation", async (c) => {
    const ctx = reqCtx(c);
    const body = await readJson<member.SelfParticipationUpdateRequest>(c);
    return c.json(await svc.updateSelfParticipation(ctx, ctx.userId, body));
  });

  // Auth for the rest of /members/*. The public internal route above is handled before
  // this runs, so exclude it here (it must not require a signed-in user).
  app.use("/members/*", async (c, next) => {
    if (c.req.path.startsWith("/members/internal/")) return next();
    return authz.requireAuth()(c, next);
  });

  // ---- overview (all three views) ----
  app.get("/members/overview", rosterRead, async (c) => {
    return c.json(await svc.getOverview(reqCtx(c)));
  });

  // チーム単位メンション用の自分視点のチーム情報 (signed-in なら誰でも可・rosterRead 不要)。
  // 名簿を読む権限が無い一般メンバーでも「@統括チーム」を選べて、受け取った側も
  // チップをチーム名で読める必要があるため。返すのはチーム(id/key/name/color)と
  // 「自分の所属 teamIds」だけで、他人の名簿行は一切含まない。
  app.get("/members/me/mention-teams", async (c) => {
    return c.json(await svc.listMentionTeams(reqCtx(c)));
  });

  // ---- teams ----
  // GET /members/teams is the CANONICAL team list other apps (e.g. gantt) read to
  // source their own team switchers ({ teams: Team[] }).
  app.get("/members/teams", rosterRead, async (c) => {
    return c.json(await svc.listTeams(reqCtx(c)));
  });
  app.post("/members/teams", requireMembersEdit, async (c) => {
    const body = await readJson<member.CreateTeamRequest>(c);
    return c.json(await svc.createTeam(reqCtx(c), body), 201);
  });
  app.patch("/members/teams/:id", requireMembersEdit, async (c) => {
    const body = await readJson<member.UpdateTeamRequest>(c);
    return c.json(await svc.updateTeam(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/teams/:id", requireMembersEdit, async (c) => {
    await svc.deleteTeam(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- people ----
  app.post("/members/people", requireMembersEdit, async (c) => {
    const body = await readJson<member.CreateMemberRequest>(c);
    return c.json(await svc.createMember(reqCtx(c), body), 201);
  });

  // ---- identity linking (#1) ----
  // Reverse lookup FIRST so the literal segment isn't shadowed by /people/:id/... routes.
  app.get("/members/people/by-identity/:identityUserId", rosterRead, async (c) => {
    const member = await svc.getByIdentityUserId(reqCtx(c), c.req.param("identityUserId"));
    return c.json({ member });
  });
  app.post("/members/people/:id/identity-link", requireMembersEdit, async (c) => {
    const body = await readJson<member.LinkIdentityRequest>(c);
    return c.json(await svc.linkIdentity(reqCtx(c), c.req.param("id"), body));
  });
  app.patch("/members/people/:id", requireMembersEdit, async (c) => {
    const body = await readJson<member.UpdateMemberRequest>(c);
    return c.json(await svc.updateMember(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/people/:id", requireMembersEdit, async (c) => {
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
  // 突合候補 (招待中/検討中のうち氏名/メール一致) — 管理者が結合先を選ぶために閲覧。
  app.get("/members/participation/:id/candidates", authz.requirePermission(READ), async (c) => {
    return c.json(await svc.listParticipationCandidates(reqCtx(c), c.req.param("id")));
  });
  // 反映確定 (link/create/skip) — roster を書き換えるので identity:admin。
  app.post("/members/participation/:id/resolve", requireParticipationEdit, async (c) => {
    const body = await readJson<member.ResolveParticipationRequest>(c);
    return c.json(await svc.resolveParticipation(reqCtx(c), c.req.param("id"), body));
  });

  return app;
}
