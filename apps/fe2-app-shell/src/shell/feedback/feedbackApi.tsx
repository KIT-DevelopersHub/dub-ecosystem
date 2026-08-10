// Feedback widget transport contract (shell chrome). The floating お問い合わせ/
// フィードバック widget POSTs here; the backend feedback endpoint (別ユニットが実装中)
// consumes this exact shape. Kept as a thin wrapper over the shared api-client so
// session/refresh/requestId/error-normalization all run unchanged (design 2-4).
import type { ApiClient } from "../../lib/api-client.tsx";

/** Category the reporter picks (optional; defaults to "other" in the UI). */
export type FeedbackCategory = "bug" | "request" | "other";

/**
 * Wire payload for POST /api/v1/feedback.
 *
 * `message` is the reporter's free text ("このアプリのここを直してほしい" 等).
 * The page-context fields are auto-attached by the widget so an administrator can
 * tell *where* the feedback was raised without asking:
 *   - pageUrl:    full href at submit time (location.href)
 *   - pagePath:   route pathname (location.pathname) — stable key for grouping
 *   - screenName: human label for the screen (document.title, falls back to path)
 *   - userAgent:  browser UA string for repro context
 */
export interface FeedbackPayload {
  message: string;
  category: FeedbackCategory;
  pageUrl: string;
  pagePath: string;
  screenName: string;
  userAgent: string;
}

/** Server ack. The endpoint may 201 with an id or 204 with no body; both resolve. */
export interface FeedbackAck {
  id?: string;
}

/** Snapshot the current page context to attach to the feedback. */
export function capturePageContext(): Pick<FeedbackPayload, "pageUrl" | "pagePath" | "screenName" | "userAgent"> {
  const loc = globalThis.location;
  const doc = globalThis.document as Document | undefined;
  const pagePath = loc?.pathname ?? "/";
  const title = doc?.title?.trim();
  return {
    pageUrl: loc?.href ?? pagePath,
    pagePath,
    screenName: title && title.length > 0 ? title : pagePath,
    userAgent: globalThis.navigator?.userAgent ?? "",
  };
}

/** POST the feedback. Errors propagate as ApiError (widget maps to a display message). */
export async function submitFeedback(api: ApiClient, payload: FeedbackPayload): Promise<FeedbackAck> {
  return api.request<FeedbackAck, FeedbackPayload>({
    method: "POST",
    path: "/api/v1/feedback",
    body: payload,
  });
}
