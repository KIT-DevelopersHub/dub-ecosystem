// In-app feedback -> admin best-effort notification. A signed-in user's feedback is
// persisted first (append-only); THEN we try to email admin@developershub.jp so the
// admin (高岡さん) is alerted. Deliverability depends on domain verification, so this
// is strictly best-effort: any failure is swallowed and never affects the saved record
// or the 201 response. Async hardening (retryable outbox) is available via @dub/freeq
// if we later want at-least-once delivery — see the handoff notes.
import type { RequestContext } from "@dub/http";
import type { mail, notification } from "@dub/types";
import type { MailPort } from "./clients";
import { ingest, type IngestDeps } from "./ingest";
import type { IngestInput } from "./types";
import {
  FEEDBACK_ADMIN_EMAIL,
  FEEDBACK_EXCERPT_LEN,
  FEEDBACK_NOTIFY_ROLE_IDS,
  FEEDBACK_NOTIFY_TYPE,
} from "./config";

function excerpt(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > FEEDBACK_EXCERPT_LEN ? `${oneLine.slice(0, FEEDBACK_EXCERPT_LEN)}…` : oneLine;
}

/** Build the admin-notification email for a stored feedback item. */
export function buildFeedbackEmail(item: notification.FeedbackItem): mail.SendMailRequest {
  const lines = [
    `新しいフィードバックが届きました。`,
    ``,
    `カテゴリ: ${item.category}`,
    `送信ユーザー: ${item.userId}`,
    `発生ページ: ${item.pageName ?? "(不明)"}${item.pageUrl ? ` <${item.pageUrl}>` : ""}`,
    `送信時刻: ${item.createdAt}`,
    `ID: ${item.id}`,
    ``,
    `--- 本文 ---`,
    item.message,
  ];
  return {
    to: [{ email: FEEDBACK_ADMIN_EMAIL, name: "DevHub 管理者" }],
    subject: `フィードバック: ${excerpt(item.message)}`,
    textBody: lines.join("\n"),
  };
}

/**
 * Best-effort: notify the admin of a newly stored feedback item. Never throws — a
 * missing binding (mail=null) or a downstream send failure is logged and swallowed so
 * the feedback save always succeeds. Returns whether the send was attempted+accepted.
 */
export async function notifyAdminOfFeedback(
  mailPort: MailPort | null,
  ctx: RequestContext,
  item: notification.FeedbackItem,
): Promise<boolean> {
  if (!mailPort) return false;
  try {
    // Idempotency key namespaced to the feedback id so retries never double-send.
    await mailPort.send(buildFeedbackEmail(item), `feedback:${item.id}`, ctx);
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "notification",
        msg: "feedback admin notify failed (best-effort; feedback saved)",
        feedbackId: item.id,
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

/**
 * Build the in-app notification for a stored feedback item, fanned out to admin /
 * maintainer users. in_app channel only (Slack / chat / email are not targeted here);
 * the dedupKey is namespaced to the feedback id so retries never create duplicates.
 */
export function buildFeedbackNotifyInput(item: notification.FeedbackItem, requestId: string): IngestInput {
  const pageLine = item.pageName ?? item.pageUrl ?? "(不明)";
  const body = [
    `カテゴリ: ${item.category}`,
    `送信ユーザー: ${item.userId}`,
    `発生ページ: ${pageLine}`,
    ``,
    excerpt(item.message),
  ].join("\n");
  return {
    type: FEEDBACK_NOTIFY_TYPE,
    recipients: { roles: [...FEEDBACK_NOTIFY_ROLE_IDS] },
    title: `新しいフィードバック: ${excerpt(item.message)}`,
    body,
    priority: "normal",
    channels: ["in_app"],
    dedupKey: `feedback:${item.id}`,
    resourceType: "feedback",
    resourceId: item.id,
    source: "api",
    actorId: item.userId,
    requestId,
  };
}

/**
 * Create an in-app notification for admin / maintainer users about a newly stored
 * feedback item. Runs the shared ingest path (synchronous D1 write into the inbox, so
 * it lands regardless of the async drain). Best-effort: a recipient-resolution failure
 * (identity unreachable) or delivery hiccup is logged and swallowed so the feedback
 * save / 201 is never affected. Idempotent via the feedback-scoped dedupKey.
 */
export async function notifyAdminsOfFeedbackInApp(
  deps: IngestDeps,
  ctx: RequestContext,
  item: notification.FeedbackItem,
): Promise<boolean> {
  try {
    await ingest(deps, buildFeedbackNotifyInput(item, ctx.requestId));
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "notification",
        msg: "feedback in-app admin notify failed (best-effort; feedback saved)",
        feedbackId: item.id,
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
