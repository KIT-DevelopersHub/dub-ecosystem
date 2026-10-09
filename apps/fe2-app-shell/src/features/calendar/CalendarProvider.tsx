// Calendar runtime provider (mirrors MailProvider / the other FE2-local features).
// Builds the CalendarApi from the ONE shell api-client and exposes it via context
// so the calendar screens read a live, session-wired client. Shaped as
// { api, children } so the shell's providerWrapper() mounts it like every feature.
//
// It ALSO surfaces the current user id (from the shell auth session) via context:
// task-service's "/me rule" only lets a user list tasks scoped to self (担当/依頼) or
// to an event, so the calendar needs to know who "self" is to build its query. This
// mirrors TaskProviders feeding マイタスク its currentUserId (moduleProviders.tsx).
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { common } from "@dub/types";
import { useAppCapability, useAuth, usePermissions } from "../../auth/AuthProvider.tsx";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createCalendarApi, type CalendarApi } from "./calendarApi.tsx";

const CalendarApiCtx = createContext<CalendarApi | null>(null);
const CalendarUserCtx = createContext<common.UserId | null>(null);

/** Which write affordances (予定の追加/編集/削除) are live. 予定 are tasks, so the
 *  server gate is マイタスク's (task-service POLICY_TABLE: app:tasks:edit + task:write,
 *  DELETE + task:delete); the calendar's own edit tier is required on top. */
export interface CalendarCaps {
  canWrite: boolean;
  canDelete: boolean;
}
const ALL_CAPS: CalendarCaps = { canWrite: true, canDelete: true };
const CalendarCapsCtx = createContext<CalendarCaps>(ALL_CAPS);

export function CalendarProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const calendarApi = useMemo(() => createCalendarApi(api), [api]);
  const auth = useAuth();
  const currentUserId = auth.status === "authenticated" ? auth.me.user.id : null;
  const { can } = usePermissions();
  const calendarCap = useAppCapability("calendar");
  const tasksCap = useAppCapability("tasks");
  const canWrite = calendarCap.canEdit && tasksCap.canEdit && can("task:write");
  const canDelete = canWrite && can("task:delete");
  const caps = useMemo(() => ({ canWrite, canDelete }), [canWrite, canDelete]);
  return (
    <CalendarApiCtx.Provider value={calendarApi}>
      <CalendarUserCtx.Provider value={currentUserId}>
        <CalendarCapsCtx.Provider value={caps}>{children}</CalendarCapsCtx.Provider>
      </CalendarUserCtx.Provider>
    </CalendarApiCtx.Provider>
  );
}

/** Test-friendly provider that injects a CalendarApi (and optional current user)
 *  directly, so screen tests need no ApiClient / auth session. */
export function CalendarApiProvider({
  value,
  currentUserId = null,
  caps = ALL_CAPS,
  children,
}: {
  value: CalendarApi;
  currentUserId?: common.UserId | null;
  caps?: CalendarCaps;
  children: ReactNode;
}): JSX.Element {
  return (
    <CalendarApiCtx.Provider value={value}>
      <CalendarUserCtx.Provider value={currentUserId}>
        <CalendarCapsCtx.Provider value={caps}>{children}</CalendarCapsCtx.Provider>
      </CalendarUserCtx.Provider>
    </CalendarApiCtx.Provider>
  );
}

export function useCalendarApi(): CalendarApi {
  const ctx = useContext(CalendarApiCtx);
  if (!ctx) throw new Error("useCalendarApi must be used within <CalendarProvider>");
  return ctx;
}

/** The signed-in user's id (null while auth is loading / unauthenticated). */
export function useCalendarCurrentUserId(): common.UserId | null {
  return useContext(CalendarUserCtx);
}

export function useCalendarCaps(): CalendarCaps {
  return useContext(CalendarCapsCtx);
}
