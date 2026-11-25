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
  FEEDBACK_NOTIFY_TYPE,
  INQUIRY_KIND_LABELS,
} from "./config";

function excerpt(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > FEEDBACK_EXCERPT_LEN ? `${oneLine.slice(0, FEEDBACK_EXCERPT_LEN)}…` : oneLine;
}

/** Admin-facing label: "フィードバック" / "権限の申請" as-is, else "問い合わせ（<種別>）". */
export function inquiryHeading(item: Pick<notification.FeedbackItem, "kind">): string {
  if (item.kind === "feedback" || item.kind === "permission_request") return INQUIRY_KIND_LABELS[item.kind];
  return `問い合わせ（${INQUIRY_KIND_LABELS[item.kind] ?? item.kind}）`;
}

/** 種別 + (feedback only) カテゴリ lines shared by the email and in-app bodies. */
function kindLines(item: notification.FeedbackItem): string[] {
  const lines = [`種別: ${INQUIRY_KIND_LABELS[item.kind] ?? item.kind}`];
  if (item.kind === "feedback") lines.push(`カテゴリ: ${item.category}`);
  return lines;
}

/** Build the admin-notification email for a stored feedback item. */
export function buildFeedbackEmail(item: notification.FeedbackItem): mail.SendMailRequest {
  const lines = [
    `新しい${inquiryHeading(item)}が届きました。`,
    ``,
    ...kindLines(item),
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
    subject: `${inquiryHeading(item)}: ${excerpt(item.message)}`,
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
 * Build the in-app notification for a stored feedback item, fanned out to every
 * notif:receive_admin holder. in_app (+ push added by ingest; Slack / chat / email are not targeted);
 * the dedupKey is namespaced to the feedback id so retries never create duplicates.
 */
export function buildFeedbackNotifyInput(item: notification.FeedbackItem, requestId: string): IngestInput {
  const pageLine = item.pageName ?? item.pageUrl ?? "(不明)";
  const body = [
    ...kindLines(item),
    `送信ユーザー: ${item.userId}`,
    `発生ページ: ${pageLine}`,
    ``,
    excerpt(item.message),
  ].join("\n");
  return {
    type: FEEDBACK_NOTIFY_TYPE,
    recipients: { audiences: ["admin"] }, // notif:receive_admin holders (ロール管理)
    title: `新しい${inquiryHeading(item)}: ${excerpt(item.message)}`,
    body,
    priority: "normal",
    audience: "admin", // "フィードバック受信" (auto-admin notification #3) — admin publishes to members
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
