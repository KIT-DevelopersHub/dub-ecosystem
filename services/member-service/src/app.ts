// Hono app — a thin HTTP adapter over MemberService. The gateway strips API_PREFIX
// and forwards /members/* to this Worker.
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives both authn (the
// trusted x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which
// lists every route below — including the /members/internal/* ones, whose x-dub-internal
// marker check used to be a hand-rolled middleware here and is now the INTERNAL rule form.
// Handlers therefore assume an authorized caller and read it with `c.get("userId")` (via
// `reqCtx`). Do NOT add a permission check to a route or a handler — add the route to the
// table (test/policy-table.test.ts fails if you forget, and the gate denies it meanwhile).
// What DOES stay here is resource-instance logic the static table cannot express: the self
// 参加届 routes resolve the caller's own roster row through their identity link, and
// submit/resolve do 氏名・メール突合 + optimistic locking (see service.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import { policyGate, type PolicyGateVars } from "@dub/policy-gate";
import type { member } from "@dub/types";
import type { AppDeps } from "./types";
import { POLICY_TABLE } from "./policy-table";
import { MemberService, type ReqCtx } from "./service";
import { HrService } from "./hr-service";
import { HrFormService } from "./hr-form-service";
import { registerHrInterviewFormRoutes } from "./hr-form-routes";
import { HrInterviewService } from "./hr-interview-service";
import { registerHrInterviewRoutes } from "./hr-interview-routes";
import type { goal, hr, sponsor } from "@dub/types";
import { GoalService } from "./goal-service";
import { SponsorService } from "./sponsor-service";
import { SponsorLeadService } from "./sponsor-lead-service";
import { SponsorMailService } from "./sponsor-mail-service";

// Actor stamped on a 参加届 that arrives through the public (unauthenticated) path.
// The gateway forwards it as a genuine service-to-service call (x-dub-internal), but
// there is no signed-in user, so submissions are attributed to this system principal.
const PUBLIC_PARTICIPATION_ACTOR = "system:public-participation";

type Vars = PolicyGateVars & { dubCtx: RequestContext };

function requestIdOf(c: Context): string {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  return ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
}

/** The acting user as the GATE established it — the single authn source now that the
 *  table owns authentication (`PolicyGateVars.userId`). */
function actorOf(c: Context): string | undefined {
  return c.get("userId") as string | undefined;
}

/** On a keyed or AUTHENTICATED route the gate guarantees an actor (it 401s otherwise), so the
 *  throw is reachable only on an INTERNAL route whose calling service propagated no user id —
 *  the check gate.ts prescribes for an internal handler that needs one. */
function reqCtx(c: Context): ReqCtx {
  const userId = actorOf(c);
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId: requestIdOf(c), userId };
}

// Like reqCtx, but for the public (unauthenticated) internal route: no signed-in user,
// so attribute the 参加届 to the system principal instead of 401ing.
function internalReqCtx(c: Context): ReqCtx {
  return { requestId: requestIdOf(c), userId: actorOf(c) ?? PUBLIC_PARTICIPATION_ACTOR };
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const svc = new MemberService(deps);
  const hrSvc = new HrService(deps, svc);
  const sponsorSvc = new SponsorService(deps);
  const sponsorLeadSvc = new SponsorLeadService(deps);
  const sponsorMailSvc = new SponsorMailService(deps);
  const goalSvc = new GoalService(deps);
  const app = new Hono<{ Variables: Vars }>();

  app.onError(dubErrorHandler({ service: "member-service" }));

  // The authorization layer. FIRST and only — every route below is gated by POLICY_TABLE,
  // which is also what makes /members/internal/* internal-only (INTERNAL rule) now that the
  // hand-rolled marker middleware is gone, and what authenticates the rest (the former
  // app.use("/members/*", requireAuth) with its internal-prefix exception).
  app.use("*", policyGate({ service: "member-service", table: POLICY_TABLE, granted: deps.authz }));

  // Request context (requestId / correlation) for every route. Not authorization — that is
  // already decided above.
  app.use("*", dubContext({ allowGenerate: true }));

  // ---- liveness (INTERNAL in the table: reachable only over a Service Binding carrying
  // x-dub-internal, which is exactly how app-health-monitor probes it). ----
  app.get("/health", (c) => c.json({ status: "ok", service: "member-service" }));

  // Public 参加届 (unauthenticated at the edge): the gateway's /public/participation
  // handler verifies Turnstile / rate-limits, then forwards here as a genuine s2s call with
  // no signed-in user, so the submission is attributed to the system actor. Roster write is
  // the same non-destructive resolve as the authenticated path.
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
    // excludeDeclined: a team mailing list delivers mail bodies, so someone who left must not
    // keep receiving them. Mentions omit it and keep notifying the whole roster as before.
    return c.json(await svc.listTeamIdentityUserIds(teamIds, { excludeDeclined: c.req.query("excludeDeclined") === "1" }));
  });

  // 名簿の Gmail 逆引き (drive-share-service → member-service, s2s のみ). カレンダー > ミーティングの
  // 招待先を「名簿の Gmail、無ければ Dub のログインメール」で決めるため。body { userIds } ->
  // { items: [{ userId, gmail, name }] } (リンク済みの行だけ)。
  app.post("/members/internal/google-emails", async (c) => {
    const body = await readJson<{ userIds?: unknown }>(c);
    const userIds = Array.isArray(body.userIds) ? body.userIds.filter((v): v is string => typeof v === "string") : [];
    return c.json(await svc.listGoogleEmails(userIds));
  });

  // 公開オンボーディング案内 (gateway GET /api/v1/public/onboarding → ここ, s2s のみ)。
  // 未ログインの新メンバーが見るページの中身。案内項目は公開前提なので応答は管理画面と同じ。
  // スポンサーのメール連携 (mail-gateway → member-service, s2s のみ・ユーザーなし)。
  app.post("/members/internal/sponsor/mail-activity", async (c) => {
    const body = await readJson<sponsor.MailActivityNotice>(c);
    return c.json(await sponsorMailSvc.recordMailActivity(body));
  });

  app.get("/members/internal/onboarding", async (c) => {
    return c.json(await svc.getOnboardingGuide());
  });

  // Self 参加届 (アカウント設定 → 参加情報). The gateway's GET/POST /api/v1/me/participation
  // authenticates the session, then forwards here as a genuine s2s call (x-dub-internal +
  // the caller's identity x-dub-user-id). Session-scoped to THAT user — no target id, and
  // resolved via the identity link to their member_people row (the resource-instance check
  // the table cannot express). reqCtx (not internalReqCtx) is used deliberately: a real
  // signed-in user id is required here (not the system actor), and INTERNAL alone does not
  // guarantee one.
  app.get("/members/internal/me/participation", async (c) => {
    const ctx = reqCtx(c);
    return c.json(await svc.getSelfParticipation(ctx.userId));
  });
  app.post("/members/internal/me/participation", async (c) => {
    const ctx = reqCtx(c);
    const body = await readJson<member.SelfParticipationUpdateRequest>(c);
    return c.json(await svc.updateSelfParticipation(ctx, ctx.userId, body));
  });

  // ---- overview (all three views) ----
  app.get("/members/overview", async (c) => {
    return c.json(await svc.getOverview(reqCtx(c)));
  });

  // 組織図までのロール向け。形は overview と同じで、個人情報の項目は空。
  app.get("/members/org-overview", async (c) => {
    return c.json(await svc.getOrgOverview(reqCtx(c)));
  });

  // チーム単位メンション用の自分視点のチーム情報 (AUTHENTICATED in the table: signed-in なら
  // 誰でも可・名簿キー不要)。名簿を読む権限が無い一般メンバーでも「@統括チーム」を選べて、
  // 受け取った側もチップをチーム名で読める必要があるため。返すのはチーム(id/key/name/color)と
  // 「自分の所属 teamIds」だけで、他人の名簿行は一切含まない。
  app.get("/members/me/mention-teams", async (c) => {
    return c.json(await svc.listMentionTeams(reqCtx(c)));
  });

  // ---- teams ----
  // GET /members/teams is the CANONICAL team list other apps (e.g. gantt) read to
  // source their own team switchers ({ teams: Team[] }).
  app.get("/members/teams", async (c) => {
    return c.json(await svc.listTeams(reqCtx(c)));
  });
  app.post("/members/teams", async (c) => {
    const body = await readJson<member.CreateTeamRequest>(c);
    return c.json(await svc.createTeam(reqCtx(c), body), 201);
  });
  app.patch("/members/teams/:id", async (c) => {
    const body = await readJson<member.UpdateTeamRequest>(c);
    return c.json(await svc.updateTeam(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/teams/:id", async (c) => {
    await svc.deleteTeam(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- people ----
  app.post("/members/people", async (c) => {
    const body = await readJson<member.CreateMemberRequest>(c);
    return c.json(await svc.createMember(reqCtx(c), body), 201);
  });

  // ---- identity linking (#1) ----
  // Reverse lookup FIRST so the literal segment isn't shadowed by /people/:id/... routes.
  app.get("/members/people/by-identity/:identityUserId", async (c) => {
    const member = await svc.getByIdentityUserId(reqCtx(c), c.req.param("identityUserId"));
    return c.json({ member });
  });
  app.post("/members/people/:id/identity-link", async (c) => {
    const body = await readJson<member.LinkIdentityRequest>(c);
    return c.json(await svc.linkIdentity(reqCtx(c), c.req.param("id"), body));
  });
  app.post("/members/people/:id/profile-reminder", async (c) => {
    return c.json(await svc.sendProfileReminder(reqCtx(c), c.req.param("id")));
  });
  app.patch("/members/people/:id", async (c) => {
    const body = await readJson<member.UpdateMemberRequest>(c);
    return c.json(await svc.updateMember(reqCtx(c), c.req.param("id"), body));
  });
  app.patch("/members/people/:id/org", async (c) => {
    const body = await readJson<member.UpdateMemberOrgRequest>(c);
    return c.json(await svc.updateMemberOrg(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/people/:id", async (c) => {
    await svc.deleteMember(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // チーム・役職ロールの一括付与 (既存メンバー向け)。dryRun で差分だけ確認できる。
  app.post("/members/role-sync/backfill", async (c) => {
    const body = await readJson<member.RoleSyncBackfillRequest>(c);
    return c.json(await svc.backfillRoles(reqCtx(c), body));
  });

  // ---- 参加届 (participation) ----
  // Submit is open to every 運営 whose role has 参加届 enabled (they file their own 届); whom a
  // 届 may be ABOUT is the handler's 氏名・メール突合 + dedupe, not a key. The admin list and the
  // 突合候補 additionally demand identity:read because they expose OTHER people's roster rows.
  app.post("/members/participation", async (c) => {
    const body = await readJson<member.SubmitParticipationRequest>(c);
    return c.json(await svc.submitParticipation(reqCtx(c), body), 201);
  });
  app.get("/members/participation", async (c) => {
    return c.json(await svc.listParticipations(reqCtx(c)));
  });
  // 突合候補 (招待中/検討中のうち氏名/メール一致) — 管理者が結合先を選ぶために閲覧。
  app.get("/members/participation/:id/candidates", async (c) => {
    return c.json(await svc.listParticipationCandidates(reqCtx(c), c.req.param("id")));
  });
  // 反映確定 (link/create/skip) — roster を書き換えるので 参加届=編集 (table)。どの名簿行に
  // 当てるかは handler 側 (突合 + version 楽観ロック)。
  app.post("/members/participation/:id/resolve", async (c) => {
    const body = await readJson<member.ResolveParticipationRequest>(c);
    return c.json(await svc.resolveParticipation(reqCtx(c), c.req.param("id"), body));
  });

  // ---- オンボーディング案内 (参加届アプリの管理タブ) ----
  // 閲覧 = 参加届の閲覧、編集系 = 参加届の編集 (table)。
  app.get("/members/onboarding", async (c) => {
    return c.json(await svc.getOnboardingGuide());
  });
  // 全体 / チームのミーティング案内 (teamId ごとに上書き・schedule 空で削除)。
  app.put("/members/onboarding/meetings", async (c) => {
    const body = await readJson<member.SaveOnboardingMeetingRequest>(c);
    return c.json(await svc.saveOnboardingMeeting(reqCtx(c), body));
  });
  app.post("/members/onboarding", async (c) => {
    const body = await readJson<member.OnboardingItemInput>(c);
    return c.json(await svc.createOnboardingItem(reqCtx(c), body), 201);
  });
  // Literal segment before /:id so it is never captured as an id.
  app.post("/members/onboarding/reorder", async (c) => {
    const body = await readJson<member.ReorderOnboardingItemsRequest>(c);
    return c.json(await svc.reorderOnboardingItems(reqCtx(c), body));
  });
  app.patch("/members/onboarding/:id", async (c) => {
    const body = await readJson<member.UpdateOnboardingItemRequest>(c);
    return c.json(await svc.updateOnboardingItem(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/onboarding/:id", async (c) => {
    await svc.deleteOnboardingItem(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- 人事: 面談申し込みフォーム (定義の編集・回答・公開ページの s2s 受付)。ルートは hr-form-routes.ts ----
  const hrInterviewSvc = new HrInterviewService(deps, hrSvc, svc);
  registerHrInterviewFormRoutes(app, new HrFormService(deps, hrSvc, (ctx, id) => hrInterviewSvc.onApplied(ctx, id)));
  registerHrInterviewRoutes(app, hrInterviewSvc);

  // ---- 人事 (面談 → 採用 → オンボーディング) ----
  // 認可は表 (人事アプリの 閲覧/編集 + hr:read / hr:write / hr:admin)。採用 (join) は名簿に行を
  // 足すので hr:admin。どの名簿行に結ぶか・ステータス遷移の妥当性・楽観ロックはハンドラ (hr-service)。
  app.get("/members/hr/applicants", async (c) => c.json(await hrSvc.list(reqCtx(c))));
  app.post("/members/hr/applicants", async (c) => {
    const body = await readJson<hr.CreateApplicantRequest>(c);
    return c.json(await hrSvc.create(reqCtx(c), body), 201);
  });
  app.get("/members/hr/applicants/:id", async (c) => c.json(await hrSvc.get(reqCtx(c), c.req.param("id"))));
  app.patch("/members/hr/applicants/:id", async (c) => {
    const body = await readJson<hr.UpdateApplicantRequest>(c);
    return c.json(await hrSvc.update(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/hr/applicants/:id", async (c) => {
    await hrSvc.remove(reqCtx(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/members/hr/applicants/:id/stage", async (c) => {
    const body = await readJson<hr.MoveApplicantStageRequest>(c);
    return c.json(await hrSvc.moveStage(reqCtx(c), c.req.param("id"), body));
  });
  app.post("/members/hr/applicants/:id/notes", async (c) => {
    const body = await readJson<hr.AddApplicantNoteRequest>(c);
    return c.json(await hrSvc.addNote(reqCtx(c), c.req.param("id"), body), 201);
  });
  app.post("/members/hr/applicants/:id/join", async (c) => {
    const body = await readJson<hr.JoinApplicantRequest>(c);
    return c.json(await hrSvc.join(reqCtx(c), c.req.param("id"), body));
  });
  app.get("/members/hr/onboarding", async (c) => c.json(await hrSvc.onboarding(reqCtx(c))));
  app.put("/members/hr/onboarding/:memberId/items/:itemId", async (c) => {
    const body = await readJson<hr.SetOnboardingCheckRequest>(c);
    return c.json(await hrSvc.setOnboardingCheck(reqCtx(c), c.req.param("memberId"), c.req.param("itemId"), body));
  });

  // ---- スポンサー (フェーズ1 = 名刺の共有) ----
  // 目標管理。認可は表、入力の検証と楽観ロックは goal-service。
  app.get("/members/goals", async (c) => c.json(await goalSvc.list(reqCtx(c), c.req.query("month"))));
  app.put("/members/goals/:teamId/:month", async (c) => {
    const body = await readJson<goal.PutGoalRequest>(c);
    return c.json(await goalSvc.put(reqCtx(c), c.req.param("teamId"), c.req.param("month"), body));
  });
  app.delete("/members/goals/:teamId/:month", async (c) => {
    await goalSvc.remove(c.req.param("teamId"), c.req.param("month"));
    return c.body(null, 204);
  });

  // 認可は表 (スポンサーアプリの 閲覧/編集 + sponsor:read / sponsor:write / sponsor:admin)。
  // 写真は JSON ではなく生のバイト列 (Content-Type = 形式)。形式・サイズ・楽観ロックはハンドラ (sponsor-service)。
  app.get("/members/sponsor/leads", async (c) => c.json(await sponsorLeadSvc.list(reqCtx(c))));
  // メール連携 (sponsor-mail-service)。一括補完は :id より先に登録する。
  app.post("/members/sponsor/leads/mail-backfill", async (c) => {
    const body = await readJson<sponsor.MailBackfillRequest>(c);
    return c.json(await sponsorMailSvc.backfill(reqCtx(c), body));
  });
  app.post("/members/sponsor/leads/:id/contact-emails", async (c) => {
    const body = await readJson<sponsor.RegisterContactEmailRequest>(c);
    return c.json(await sponsorMailSvc.registerContactEmail(reqCtx(c), c.req.param("id"), body));
  });
  app.get("/members/sponsor/leads/:id/activity", async (c) => c.json(await sponsorMailSvc.listActivity(reqCtx(c), c.req.param("id"))));
  app.post("/members/sponsor/leads", async (c) => {
    const body = await readJson<sponsor.CreateLeadRequest>(c);
    return c.json(await sponsorLeadSvc.create(reqCtx(c), body), 201);
  });
  app.post("/members/sponsor/leads/import", async (c) => {
    const body = await readJson<sponsor.ImportLeadsRequest>(c);
    return c.json(await sponsorLeadSvc.importLeads(reqCtx(c), body), 201);
  });
  app.get("/members/sponsor/leads/:id", async (c) => c.json(await sponsorLeadSvc.get(reqCtx(c), c.req.param("id"))));
  app.patch("/members/sponsor/leads/:id", async (c) => {
    const body = await readJson<sponsor.UpdateLeadRequest>(c);
    return c.json(await sponsorLeadSvc.update(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/sponsor/leads/:id", async (c) => {
    await sponsorLeadSvc.remove(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });
  // 目標値は目標管理アプリの KPI が正で、ここは読むだけ。
  app.get("/members/sponsor/goals", async (c) => c.json(await goalSvc.sponsorGoals()));
  app.get("/members/sponsor/cards", async (c) => c.json(await sponsorSvc.list(reqCtx(c))));
  app.post("/members/sponsor/cards", async (c) => {
    const body = await readJson<sponsor.CreateCardRequest>(c);
    return c.json(await sponsorSvc.create(reqCtx(c), body), 201);
  });
  app.get("/members/sponsor/cards/:id", async (c) => c.json(await sponsorSvc.get(reqCtx(c), c.req.param("id"))));
  app.patch("/members/sponsor/cards/:id", async (c) => {
    const body = await readJson<sponsor.UpdateCardRequest>(c);
    return c.json(await sponsorSvc.update(reqCtx(c), c.req.param("id"), body));
  });
  app.delete("/members/sponsor/cards/:id", async (c) => {
    await sponsorSvc.remove(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });
  app.put("/members/sponsor/cards/:id/image", async (c) => {
    const len = Number(c.req.header("content-length"));
    const card = await sponsorSvc.putImage(
      reqCtx(c),
      c.req.param("id"),
      c.req.header("content-type"),
      () => c.req.arrayBuffer(),
      Number.isFinite(len) && len > 0 ? len : undefined,
    );
    return c.json(card);
  });
  app.get("/members/sponsor/cards/:id/image", async (c) => {
    const img = await sponsorSvc.getImage(reqCtx(c), c.req.param("id"));
    return c.body(img.body, 200, { "content-type": img.contentType, "cache-control": "private, max-age=300" });
  });

  return app;
}
