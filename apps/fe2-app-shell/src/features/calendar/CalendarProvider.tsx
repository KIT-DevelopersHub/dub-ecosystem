// Calendar runtime provider (mirrors MailProvider / the other FE2-local features).
// Builds the CalendarApi from the ONE shell api-client and exposes it via context
// so the calendar screens read a live, session-wired client. Shaped as
// { api, children } so the shell's providerWrapper() mounts it like every feature.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createCalendarApi, type CalendarApi } from "./calendarApi.tsx";

const CalendarApiCtx = createContext<CalendarApi | null>(null);

export function CalendarProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const calendarApi = useMemo(() => createCalendarApi(api), [api]);
  return <CalendarApiCtx.Provider value={calendarApi}>{children}</CalendarApiCtx.Provider>;
}

/** Test-friendly provider that injects a CalendarApi directly (no ApiClient needed). */
export function CalendarApiProvider({ value, children }: { value: CalendarApi; children: ReactNode }): JSX.Element {
  return <CalendarApiCtx.Provider value={value}>{children}</CalendarApiCtx.Provider>;
}

export function useCalendarApi(): CalendarApi {
  const ctx = useContext(CalendarApiCtx);
  if (!ctx) throw new Error("useCalendarApi must be used within <CalendarProvider>");
  return ctx;
}
