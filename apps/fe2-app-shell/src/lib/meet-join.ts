// 定例の出席: open a meeting's Meet through Dub so the join is recorded (POST /meetings/:id/join).
// The tab is opened synchronously in the click (popup blockers allow only that) and pointed at the
// Meet link once the join answers. A failed join still lets the member in via the known link —
// attendance is never a reason to keep someone out of a meeting.
import type { meeting } from "@dub/types";
import type { ApiClient } from "./api-client.tsx";

export function joinMeetingRequest(api: ApiClient, meetingId: string): Promise<meeting.JoinMeetingResponse> {
  return api.request<meeting.JoinMeetingResponse>({ method: "POST", path: `/api/v1/meetings/${encodeURIComponent(meetingId)}/join` });
}

/** Opens the Meet in a new tab after recording the join. Resolves with the join answer (null = join failed). */
export async function openMeetWithAttendance(
  join: () => Promise<meeting.JoinMeetingResponse>,
  fallbackUrl: string | null,
  win: Pick<Window, "open"> = window,
): Promise<meeting.JoinMeetingResponse | null> {
  const tab = win.open("", "_blank");
  if (tab) tab.opener = null;
  let res: meeting.JoinMeetingResponse | null = null;
  try {
    res = await join();
  } catch {
    res = null;
  }
  const url = res?.meetUrl ?? fallbackUrl;
  if (tab) {
    if (url) tab.location.href = url;
    else tab.close();
  } else if (url) {
    win.open(url, "_blank", "noopener,noreferrer");
  }
  return res;
}

/** 「Googleと連携」: Google comes back to /driveshare (the Web client's one return page), where
 *  GoogleLinkReturn finishes the link. */
export async function startGoogleLink(api: ApiClient, loc: Pick<Location, "origin" | "assign"> = window.location): Promise<void> {
  const res = await api.request<meeting.StartGoogleLinkResponse, meeting.StartGoogleLinkRequest>({
    method: "POST",
    path: "/api/v1/meetings/me/google-link/start",
    body: { redirectUri: `${loc.origin}/driveshare` },
  });
  loc.assign(res.authUrl);
}

export function completeGoogleLink(api: ApiClient, code: string, state: string): Promise<{ googleLinked: true }> {
  return api.request<{ googleLinked: true }, meeting.CompleteGoogleLinkRequest>({
    method: "POST",
    path: "/api/v1/meetings/me/google-link/callback",
    body: { code, state },
  });
}
