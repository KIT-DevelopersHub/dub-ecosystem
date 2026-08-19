// 参加届 → 管理者(admin) への in-app 通知。
//
// A 参加届 (participation) submission arrives at member-service (public or 運営 path).
// When it lands we fan out ONE in-app notification to the admin / maintainer roles via
// notification-service `POST /notify` (the same role-fanout the usage-alert and feedback
// flows use). The notification-service resolves the roles to each admin's inbox, so it
// shows up in their 通知一覧 and bumps the unread badge — no per-user id config needed.
//
// Strictly best-effort: a missing binding (SVC_NOTIFICATION absent) or any downstream
// failure is swallowed so the 参加届 save / 201 response is NEVER affected. Idempotent via
// a participation-scoped dedupKey, so retries never double-notify.
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import type { member, notification } from "@dub/types";

// Admin fan-out roles — mirrors the feedback / usage-alert → admin flow. notification-service
// expands these to the matching users' inboxes, so admins are reached without any user-id config.
export const PARTICIPATION_NOTIFY_ROLE_IDS = ["role_sys_admin", "role_sys_maintainer"] as const;
export const PARTICIPATION_NOTIFY_TYPE = "member.participation.submitted";

/** Build the admin in-app notification for a submitted 参加届. in_app only; dedupKey is
 *  namespaced to the participation id so an upsert/retry never creates a duplicate row. */
export function buildParticipationNotify(p: member.Participation): notification.NotifyRequest {
  const body = [
    `氏名: ${p.name}`,
    p.grade ? `学年: ${p.grade}` : null,
    p.department ? `所属: ${p.department}` : null,
    p.desiredActivity ? `希望する活動: ${p.desiredActivity}` : null,
    `学校メール: ${p.schoolEmail}`,
    `Gmail: ${p.gmail}`,
    p.phone ? `電話: ${p.phone}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return {
    type: PARTICIPATION_NOTIFY_TYPE,
    recipientIds: [],
    recipientRoles: [...PARTICIPATION_NOTIFY_ROLE_IDS],
    title: `新しい参加届: ${p.name}`,
    body,
    channels: ["in_app"],
    dedupKey: `participation:${p.id}`,
    resourceType: "participation",
    resourceId: p.id,
  };
}

/**
 * Best-effort: notify admins of a newly submitted 参加届. Never throws — a missing binding
 * or a downstream error is logged and swallowed so the submission always succeeds.
 * Returns whether the notify was attempted+accepted (useful for tests / metrics).
 */
export async function notifyAdminsOfParticipation(
  svcNotification: Fetcher | undefined,
  ctx: RequestContext,
  p: member.Participation,
): Promise<boolean> {
  if (!svcNotification) return false;
  try {
    const client = createServiceClient(svcNotification, { service: "notification", caller: "member-service" });
    await client.post<{ notificationId: string; deduplicated: boolean }, notification.NotifyRequest>(
      ctx,
      "/notify",
      buildParticipationNotify(p),
    );
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "member-service",
        msg: "participation admin notify failed (best-effort; submission saved)",
        participationId: p.id,
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
