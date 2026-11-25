// Worker entrypoint. Wires the runtime env (D1, identity Service Binding) into
// AppDeps and serves the Hono app. Must stay import-clean for `wrangler dev`.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { newRequestId } from "@dub/http";
import { sharedAuthzGranter } from "@dub/policy-gate";
import { common } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1MemberRepo } from "./d1-repo";
import { createD1HrRepo } from "./hr-repo";
import { createD1HrFormRepo } from "./hr-form-repo";
import { createD1HrInterviewRepo } from "./hr-interview-repo";
import { createD1HrResultRepo } from "./hr-result-repo";
import { interviewerNotifierVia, sendHrMailVia } from "./hr-interview-mail";
import { createD1GoalRepo, createGoalSources } from "./goal-repo";
import { createD1SponsorRepo, r2ImageStore } from "./sponsor-repo";
import { createD1SponsorLeadRepo } from "./sponsor-lead-repo";
import { createD1SponsorMailRepo } from "./sponsor-mail-repo";
import { mailContactsVia } from "./sponsor-mail-client";
import { notifyAdminsOfParticipation } from "./participationNotify";
import { sendProfileReminderVia } from "./profileReminder";
import { createIdentityRoleSync } from "./roleSync";
import { createIdentityActivation } from "./identityActivation";
import type { Env } from "./env";
import type { AppDeps } from "./types";

export type { Env } from "./env";

export function buildDeps(env: Env, requestId?: string, exec?: ExecutionContext): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "member",
    ...(requestId ? { requestId } : {}),
    logger: (e) =>
      consoleSink({ level: "debug", message: "db", service: "member-service", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  // sharedAuthzGranter (not createAuthzGranter): buildDeps runs per request, so the identity
  // /authz/check TTL cache has to be memoized per Env to survive between requests in the same
  // isolate — otherwise every gated route is an unconditional identity subrequest and
  // identity-roster becomes a hot-path single point of failure (ADR 0004).
  const authz = sharedAuthzGranter(env, env.SVC_IDENTITY, {
    caller: "member-service",
    requestId: requestId ?? newRequestId(),
  });
  return {
    repo: createD1MemberRepo(db),
    authz,
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    now: nowIso,
    newTeamId: () => newId("team"),
    newMemberId: () => newId("member"),
    newParticipationId: () => newId("part"),
    newOnboardingItemId: () => newId("onb"),
    hrRepo: createD1HrRepo(db),
    hrFormRepo: createD1HrFormRepo(db),
    hrInterviewRepo: createD1HrInterviewRepo(db),
    hrResultRepo: createD1HrResultRepo(db),
    ...(env.SVC_MAIL ? { sendHrMail: sendHrMailVia(env.SVC_MAIL) } : {}),
    ...(env.SVC_NOTIFICATION ? { notifyInterviewer: interviewerNotifierVia(env.SVC_NOTIFICATION) } : {}),
    ...(env.APP_BASE_URL ? { appBaseUrl: env.APP_BASE_URL } : {}),
    ...(exec ? { defer: (work: Promise<void>) => exec.waitUntil(work) } : {}),
    // 名簿のチーム・役職 -> identity の自動ロール (best-effort・PUT /internal/*managed-roles)。
    roleSync: createIdentityRoleSync(env.SVC_IDENTITY),
    // 在籍で紐付いた人の招待中アカウントを有効化 (best-effort・POST /internal/users/:id/activate)。
    identityActivation: createIdentityActivation(env.SVC_IDENTITY),
    newHrId: (prefix) => newId(prefix),
    sponsorRepo: createD1SponsorRepo(db),
    ...(env.SPONSOR_FILES ? { sponsorImages: r2ImageStore(env.SPONSOR_FILES) } : {}),
    newSponsorCardId: () => newId("card"),
    sponsorLeadRepo: createD1SponsorLeadRepo(db),
    newSponsorLeadId: () => newId("lead"),
    sponsorMailRepo: createD1SponsorMailRepo(db),
    newSponsorMailId: (prefix) => newId(prefix),
    ...(env.SVC_MAIL ? { mailContacts: mailContactsVia(env.SVC_MAIL) } : {}),
    goalRepo: createD1GoalRepo(db),
    goalSources: createGoalSources(env),
    // 参加届が届いたら管理者(admin/maintainer)へ in-app 通知を1件出す（best-effort）。
    notifyParticipationSubmitted: (ctx, participation) =>
      notifyAdminsOfParticipation(env.SVC_NOTIFICATION, ctx, participation).then(() => undefined),
    ...(env.SVC_NOTIFICATION ? { sendProfileReminder: sendProfileReminderVia(env.SVC_NOTIFICATION) } : {}),
  };
}

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId, exec));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },
};

export { createApp } from "./app";
export { MemberService } from "./service";
export { createD1MemberRepo } from "./d1-repo";
export { InMemoryMemberRepo } from "./memory-repo";
export {
  MEMBER_SCHEMA_MIGRATION,
  MEMBER_IDENTITY_LINK_MIGRATION,
  MEMBER_PERSON_COLS_MIGRATION,
  MEMBER_PARTICIPATION_MIGRATION,
  MEMBER_PARTICIPATION_EMAILS_MIGRATION,
  MEMBER_MIGRATIONS,
} from "./schema";
export type { AppDeps } from "./types";
