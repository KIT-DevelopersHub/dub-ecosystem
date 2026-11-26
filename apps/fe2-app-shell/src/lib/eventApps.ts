// 使うアプリ (per-event enabled apps) for the shell launcher. Reads the CURRENT event
// (the header switcher's selection, FE3's store) and its enabled set through the same
// query key FE3's イベント設定 writes optimistically, so flipping a switch there greys
// the tile here at once.
//
// This is a UX setting, not authorization: while unknown (no event selected, loading,
// no event:read, error) it returns null and nothing is greyed — the launcher stays
// exactly as before. Disabled apps are greyed with a reason, never removed (消さない).
import { useQuery } from "@tanstack/react-query";
import type { event } from "@dub/types";
import { eventKeys, useCurrentEventId } from "@dub/fe3-event-action";
import type { ApiClient } from "./api-client.tsx";

/** Tooltip on a greyed tile. */
export const EVENT_DISABLED_REASON = "このイベントでは使わない設定です（イベント > 設定・使うアプリ で変更）";

export function useCurrentEventEnabledApps(api: ApiClient | undefined, canRead: boolean): ReadonlySet<string> | null {
  const eventId = useCurrentEventId();
  const enabled = Boolean(api && eventId && canRead);
  const { data } = useQuery({
    queryKey: eventKeys.apps(eventId ?? ""),
    queryFn: () => api!.request<event.EventAppsResponse>({ method: "GET", path: `/api/v1/events/${eventId}/apps` }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  if (!enabled || !data) return null;
  return new Set(data.enabledApps);
}

/** True when the tile of `appId` should be greyed for the current event. */
export function isEventDisabled(appId: string | undefined, enabledApps: ReadonlySet<string> | null): boolean {
  return Boolean(appId && enabledApps && !enabledApps.has(appId));
}
