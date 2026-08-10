// In-app feedback -> admin best-effort notification. A signed-in user's feedback is
// persisted first (append-only); THEN we try to email admin@developershub.jp so the
// admin (高岡さん) is alerted. Deliverability depends on domain verification, so this
// is strictly best-effort: any failure is swallowed and never affects the saved record
// or the 201 response. Async hardening (retryable outbox) is available via @dub/freeq
// if we later want at-least-once delivery — see the handoff notes.
import type { RequestContext } from "@dub/http";
import type { mail, notification } from "@dub/types";
import type { MailPort } from "./clients";
import { FEEDBACK_ADMIN_EMAIL, FEEDBACK_EXCERPT_LEN } from "./config";

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
