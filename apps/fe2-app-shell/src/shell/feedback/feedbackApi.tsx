// Feedback widget transport contract (shell chrome). The floating お問い合わせ/
// フィードバック widget POSTs here; the backend feedback endpoint (notification-service
// POST /feedback) consumes this exact shape. Kept as a thin wrapper over the shared
// api-client so session/refresh/requestId/error-normalization all run unchanged
// (design 2-4).
import type { ApiClient } from "../../lib/api-client.tsx";

/**
 * Category the reporter picks (optional; defaults to "other" in the UI). MUST match the
 * backend enum (notification-service FEEDBACK_CATEGORIES = bug|idea|question|other); a
 * value outside this set is rejected with 400 invalid_enum, so the widget options are
 * bound to it.
 */
export type FeedbackCategory = "bug" | "idea" | "question" | "other";

/**
 * Widget-side input for a feedback submission. The page-context fields are auto-attached
 * by the widget (via capturePageContext) so an administrator can tell *where* the
 * feedback was raised without asking; submitFeedback maps them onto the backend wire
 * shape below:
 *   - pageUrl:    full href at submit time (location.href)     -> page.url
 *   - pagePath:   route pathname (location.pathname)           -> shown in the UI only
 *   - screenName: human label for the screen (document.title)  -> page.name
 *   - userAgent:  browser UA string                            -> sent as the UA header
 */
export interface FeedbackInput {
  message: string;
  category: FeedbackCategory;
  pageUrl: string;
  pagePath: string;
  screenName: string;
  userAgent: string;
}

/**
 * Wire body for POST /api/v1/feedback — the backend's frozen contract. `page` is a
 * nested { url, name } object (NOT flat pageUrl/screenName), and the submitter's user
 * agent is read from the HTTP header, not the body.
 */
interface FeedbackWireBody {
  message: string;
  category: FeedbackCategory;
  page: { url: string; name: string };
}

/** Server ack. The endpoint may 201 with an id or 204 with no body; both resolve. */
export interface FeedbackAck {
  id?: string;
}

/** Snapshot the current page context to attach to the feedback. */
export function capturePageContext(): Pick<FeedbackInput, "pageUrl" | "pagePath" | "screenName" | "userAgent"> {
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

/**
 * POST the feedback. Maps the flat widget input onto the backend's nested `page` wire
 * shape so the admin notification records the originating page (previously dropped, as
 * the backend ignores unknown flat fields). Errors propagate as ApiError (widget maps
 * to a display message).
 */
export async function submitFeedback(api: ApiClient, input: FeedbackInput): Promise<FeedbackAck> {
  const body: FeedbackWireBody = {
    message: input.message,
    category: input.category,
    page: { url: input.pageUrl, name: input.screenName },
  };
  return api.request<FeedbackAck, FeedbackWireBody>({
    method: "POST",
    path: "/api/v1/feedback",
    body,
  });
}
