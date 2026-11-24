// Role follow: a role's Drive共有 grants and ミーティング invitations reach the people who join the
// role LATER, and leave the people who leave it.
//
// Trigger: identity-roster writes one freeq outbox row (topic identity.ROLE_MEMBERSHIP_TOPIC) per user
// whose role membership changed; freeq-drain delivers it here (POST /internal/role-membership) within
// about a minute and retries with backoff while this answers non-2xx. The message only says WHICH
// roles to re-check — membership is read again from identity / 名簿 on delivery, and every step is
// idempotent (Drive: the grant ledger + the live permissions; calendar: the invite ledger), so a
// duplicate or late delivery changes nothing.
//
//   Drive共有   — the grants of those roles are reconciled now (RoleGrantsService.followRoles).
//   ミーティング — the MeetingSyncDO sync is pulled to now when a live meeting invites one of those
//                 roles; it already adds / removes attendees for meetings still to come and never
//                 touches an ended one.
//
// The hourly MeetingSyncDO cycle stays the safety net (a lost message is caught within the hour for
// joins). POST /driveshare/role-grants/reconcile is the one-off backfill, dry-run by default.
import { errors } from "@dub/errors";
import { identity, type meeting } from "@dub/types";
import type { MeetingsService } from "./meetings-service";
import type { RoleGrantsService } from "./role-grants-service";

/** Per delivery. Not under the gateway's 15 s (freeq-drain calls over a Service Binding). */
const FOLLOW_BUDGET_MS = 20_000;
const FOLLOW_MAX_WRITES = 30;
/** Per backfill request (through the gateway). */
const RECONCILE_BUDGET_MS = 8_000;
const RECONCILE_MAX_WRITES = 25;

export interface RoleFollowDeps {
  /** System-actor role grants with the strict 名簿 lookup. live = a real Google account is connected
   *  (false: the mock / nothing connected — only planning is meaningful). */
  roleGrants: () => Promise<{ service: RoleGrantsService; live: boolean }>;
  meetings: () => Promise<Pick<MeetingsService, "plan" | "followsAnyRole">>;
  /** Pull the meeting sync to now (MeetingSyncDO kick). */
  kickCalendar: () => Promise<void>;
}

export interface RoleFollowService {
  /** One RoleMembershipChangedV1 from the outbox. Throws (non-2xx) when it should be retried. */
  handle(body: unknown): Promise<meeting.RoleMembershipFollowResponse>;
  /** The backfill: plan (dryRun, default) or apply one budgeted step. */
  reconcile(body: unknown): Promise<meeting.RoleGrantReconcileResponse>;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: "drive-share-service", event, ...fields }));
}

/** A well-formed message, or null (logged and acknowledged: retrying cannot fix it). */
export function parseMembershipMessage(body: unknown): identity.RoleMembershipChangedV1 | null {
  if (!body || typeof body !== "object") return null;
  const m = body as Partial<identity.RoleMembershipChangedV1>;
  if (m.type !== "identity.role_membership.changed" || m.version !== 1) return null;
  if (typeof m.userId !== "string" || !m.userId) return null;
  if (m.change !== "added" && m.change !== "removed") return null;
  if (!Array.isArray(m.roleIds) || m.roleIds.length === 0 || !m.roleIds.every((r) => typeof r === "string" && r.length > 0)) return null;
  return m as identity.RoleMembershipChangedV1;
}

export function createRoleFollowService(deps: RoleFollowDeps): RoleFollowService {
  return {
    async handle(body) {
      const msg = parseMembershipMessage(body);
      if (!msg) {
        log("role_follow_ignored_malformed", {});
        return { ignored: true, drive: null, calendarSyncKicked: false };
      }
      // Calendar first: cheap, and the sync it pulls does the work (with its own retries / pacing).
      let calendarSyncKicked = false;
      if (await (await deps.meetings()).followsAnyRole(msg.roleIds)) {
        await deps.kickCalendar();
        calendarSyncKicked = true;
      }
      const { service, live } = await deps.roleGrants();
      if (!live) {
        log("role_follow_drive_skipped_no_account", { messageId: msg.id });
        return { drive: null, calendarSyncKicked };
      }
      let res;
      try {
        res = await service.followRoles(msg.roleIds, msg.change, { budgetMs: FOLLOW_BUDGET_MS, maxWrites: FOLLOW_MAX_WRITES });
      } catch (err) {
        log("role_follow_failed", { messageId: msg.id, userId: msg.userId, change: msg.change, roleIds: msg.roleIds, message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      log("role_follow_done", {
        messageId: msg.id,
        userId: msg.userId,
        change: msg.change,
        reason: msg.reason,
        roleIds: msg.roleIds,
        grants: res.grants,
        shared: res.shared,
        revoked: res.revoked,
        held: res.held,
        complete: res.complete,
        calendarSyncKicked,
        // Refusals (e.g. an address Google will not take) are not retried here; the hourly sync tries again.
        refused: res.skipped,
      });
      if (!res.complete) throw errors.upstreamUnavailable("google-drive (budget spent; continues on retry)");
      return { drive: { grants: res.grants, shared: res.shared, revoked: res.revoked, held: res.held, refused: res.skipped.length }, calendarSyncKicked };
    },

    async reconcile(body) {
      const dryRun = !(body && typeof body === "object" && (body as meeting.RoleGrantReconcileRequest).dryRun === false);
      const { service, live } = await deps.roleGrants();
      const meetings = await deps.meetings();
      const [drive, calendar] = await Promise.all([service.planReconcile(), meetings.plan()]);
      log("role_reconcile_planned", {
        dryRun,
        grants: drive.grants,
        toShare: drive.toShare.length,
        toRevoke: drive.toRevoke.length,
        orphanGrants: drive.orphanGrants.length,
        toInvite: calendar.toInvite.length,
        toUninvite: calendar.toUninvite.length,
        removalsHeld: calendar.removalsHeld.length,
      });
      if (dryRun) return { dryRun, drive, calendar };
      if (!live) throw errors.conflict("Google アカウントが接続されていないため反映できません。Drive共有 > 設定 で接続してください。", { reason: "no_google_account" });

      const applied = await service.applyReconcile({ budgetMs: RECONCILE_BUDGET_MS, maxWrites: RECONCILE_MAX_WRITES });
      const calendarSyncKicked = calendar.toInvite.length + calendar.toUninvite.length > 0;
      if (calendarSyncKicked) await deps.kickCalendar();
      log("role_reconcile_applied", { shared: applied.shared, revoked: applied.revoked, refused: applied.skipped.length, remaining: applied.remaining, calendarSyncKicked });
      return { dryRun, drive, calendar, applied: { ...applied, calendarSyncKicked } };
    },
  };
}
