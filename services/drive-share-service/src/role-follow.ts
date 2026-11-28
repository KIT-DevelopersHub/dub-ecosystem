// Role follow: a role's Drive共有 grants and ミーティング invitations reach the people who join the
// role LATER, and leave the people who leave it — at the moment the membership changes.
//
// Trigger: identity-roster calls POST /internal/role-membership synchronously, inside the request that
// changes the membership (assign / revoke / 名簿 auto-roles / role delete / (de)activation / offboard),
// and waits for the answer. A call that fails or is left unfinished (`retry`) is queued by identity on
// the freeq outbox and redelivered to /internal/role-membership-async (#908). The message only says WHICH roles to re-check — membership is
// read again from identity / 名簿 here, and every step is idempotent (Drive: the grant ledger + the
// live permissions; calendar: the invite ledger), so a repeated call changes nothing.
//
//   Drive共有   — the grants of those roles are reconciled now (RoleGrantsService.followRoles).
//   ミーティング — attendees of the live meetings that invite those roles are reconciled now
//                 (MeetingsService.syncRoles; ended meetings untouched). Calendar SHARES ("add this
//                 calendar") are paced against Google's limits, so they stay with MeetingSyncDO.
//
// Whatever did not finish comes back in `problems` (never an error for a refusal of one address);
// identity shows it to the admin. The hourly MeetingSyncDO cycle is only the safety net.
// POST /driveshare/role-grants/reconcile is the one-off backfill, dry-run by default.
import { errors } from "@dub/errors";
import { identity, type meeting } from "@dub/types";
import type { MeetingsService } from "./meetings-service";
import type { RoleGrantsService } from "./role-grants-service";

/** Per call. identity waits for the answer inside an admin request (api-gateway cuts at 15 s), so
 *  each part does what fits in a few seconds; the rest is reported and left to the hourly sync. */
const FOLLOW_DRIVE_BUDGET_MS = 4_000;
const FOLLOW_DRIVE_MAX_WRITES = 12;
/** Per backfill request (through the gateway). */
const RECONCILE_BUDGET_MS = 8_000;
const RECONCILE_MAX_WRITES = 25;

export interface RoleFollowDeps {
  /** System-actor role grants with the strict 名簿 lookup. live = a real Google account is connected
   *  (false: the mock / nothing connected — only planning is meaningful). */
  roleGrants: () => Promise<{ service: RoleGrantsService; live: boolean }>;
  meetings: () => Promise<Pick<MeetingsService, "plan" | "followsAnyRole" | "syncRoles">>;
  /** Make sure the paced calendar-share sync runs soon (MeetingSyncDO kick). */
  kickCalendar: () => Promise<void>;
}

export interface RoleFollowService {
  /** One RoleMembershipChangedV1 from identity. Never throws for Google: what did not finish is in `problems`. */
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
        return { ignored: true, drive: null, calendar: null, complete: true, problems: [] };
      }
      const problems: string[] = [];
      // A part that threw, ran out of time or was paused can still finish on a retry (the outbox
      // redelivery); an address Google refused or a missing calendar scope cannot.
      let retry = false;
      const failed = (part: string, err: unknown) => {
        retry = true;
        log("role_follow_failed", { messageId: msg.id, userId: msg.userId, change: msg.change, roleIds: msg.roleIds, part, message: err instanceof Error ? err.message : String(err) });
        problems.push(`${part}を反映できませんでした（${err instanceof Error ? err.message : String(err)}）。毎時の同期で再試行します。`);
      };

      let drive: meeting.RoleMembershipFollowResponse["drive"] = null;
      try {
        const { service, live } = await deps.roleGrants();
        if (live) {
          const res = await service.followRoles(msg.roleIds, msg.change, { budgetMs: FOLLOW_DRIVE_BUDGET_MS, maxWrites: FOLLOW_DRIVE_MAX_WRITES });
          drive = { grants: res.grants, shared: res.shared, revoked: res.revoked, held: res.held, refused: res.skipped.length, complete: res.complete };
          if (!res.complete) {
            retry = true;
            problems.push("Drive共有の一部が時間内に終わりませんでした。残りは毎時の同期で反映します。");
          }
          if (res.skipped.length > 0) problems.push(`Drive共有で Google が受け付けなかった宛先があります: ${res.skipped.map((s) => `${s.email}（${s.reason}）`).join("、")}`);
          if (msg.change === "removed" && res.held > 0) problems.push("ロールが見つからないか 0 人に見えるため、Drive共有の削除を保留しました。必要なら Drive共有 で付与を外してください。");
          log("role_follow_drive", { messageId: msg.id, userId: msg.userId, change: msg.change, reason: msg.reason, roleIds: msg.roleIds, ...drive, refused: res.skipped });
        }
      } catch (err) {
        failed("Drive共有", err);
      }

      let calendar: meeting.RoleMembershipFollowResponse["calendar"] = null;
      try {
        const meetings = await deps.meetings();
        if (await meetings.followsAnyRole(msg.roleIds)) {
          const r = await meetings.syncRoles(msg.roleIds);
          // The role calendars' shares are paced (Google limits): the sync writes them shortly.
          await deps.kickCalendar().catch((err: unknown) => log("role_follow_kick_failed", { message: err instanceof Error ? err.message : String(err) }));
          calendar = { meetings: r.meetings, invitedAdded: r.invitedAdded, invitedRemoved: r.invitedRemoved, complete: r.complete && !r.skipped, ...(r.skipped ? { skipped: r.skipped } : {}), sharesPending: true };
          if (!calendar.complete && r.skipped !== "not_ready") retry = true;
          if (r.skipped === "quota_paused") problems.push("Google カレンダーの利用上限で同期が一時停止中のため、ミーティングの招待は停止明けに反映します。");
          else if (r.skipped === "not_ready") problems.push("Google アカウントにカレンダーの権限が無いため、ミーティングの招待を反映できません。Drive共有 > 設定 で再接続してください。");
          else if (!r.complete) problems.push("ミーティングの招待の一部が時間内に終わりませんでした。残りは毎時の同期で反映します。");
          log("role_follow_calendar", { messageId: msg.id, userId: msg.userId, change: msg.change, roleIds: msg.roleIds, ...calendar });
        }
      } catch (err) {
        failed("ミーティングの招待", err);
      }
      return { drive, calendar, complete: problems.length === 0, problems, ...(retry ? { retry } : {}) };
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
      // Attendees of every live meeting with a role target, now (same reconcile as the sync).
      const cal = calendar.toInvite.length + calendar.toUninvite.length > 0 ? await meetings.syncRoles("all") : null;
      if (cal) await deps.kickCalendar();
      log("role_reconcile_applied", { shared: applied.shared, revoked: applied.revoked, refused: applied.skipped.length, remaining: applied.remaining, calendar: cal });
      return {
        dryRun,
        drive,
        calendar,
        applied: { ...applied, calendarSyncKicked: cal !== null, ...(cal ? { calendarInvited: cal.invitedAdded, calendarUninvited: cal.invitedRemoved, calendarComplete: cal.complete && !cal.skipped } : {}) },
      };
    },
  };
}
