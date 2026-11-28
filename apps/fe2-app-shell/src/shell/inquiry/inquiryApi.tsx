// 問い合わせ transport (⚙ → 問い合わせ). POSTs the backend feedback endpoint
// (notification POST /feedback, external /api/v1/feedback) through the shared api-client
// so session/refresh/requestId/error-normalization all run unchanged. Wire shape is the
// shared contract notification.CreateFeedbackRequest.
import type { notification } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import { captureDeviceContext } from "./deviceContext.ts";
import type { FeedbackCategory, InquiryKind } from "./inquiryKinds.ts";

/**
 * Dialog-side input. The page-context fields are auto-attached (capturePageContext) so
 * an admin can tell where the inquiry was raised:
 *   - pageUrl:    location.href     -> page.url
 *   - pagePath:   location.pathname -> shown in the UI only
 *   - screenName: document.title    -> page.name
 *   - userAgent:  browser UA        -> the UA header (and device.userAgent)
 * Device context (client区分・OS・ブラウザ・画面・アプリの版) is attached by submitInquiry
 * itself (captureDeviceContext), so every caller sends it without asking the user.
 */
export interface InquiryInput {
  kind: InquiryKind;
  message: string;
  category: FeedbackCategory;
  pageUrl: string;
  pagePath: string;
  screenName: string;
  userAgent: string;
}

/** Server ack. The endpoint may 201 with an id or 204 with no body; both resolve. */
export interface InquiryAck {
  id?: string;
}

/** Snapshot the current page context to attach to the inquiry. */
export function capturePageContext(): Pick<InquiryInput, "pageUrl" | "pagePath" | "screenName" | "userAgent"> {
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

/** POST the inquiry, mapping the flat input onto the nested `page` wire shape. */
export async function submitInquiry(api: ApiClient, input: InquiryInput): Promise<InquiryAck> {
  const body: notification.CreateFeedbackRequest = {
    message: input.message,
    kind: input.kind,
    category: input.category,
    page: { url: input.pageUrl, name: input.screenName },
    device: captureDeviceContext(),
  };
  return api.request<InquiryAck, notification.CreateFeedbackRequest>({
    method: "POST",
    path: "/api/v1/feedback",
    body,
  });
}
