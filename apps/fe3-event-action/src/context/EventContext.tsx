// EventContextProvider / useEventContext — the shared "current event" context all
// event-scoped screens (and FE4/FE5/FE6 panels) read from. Data source is the
// GET /events/:id?include=actions detail plus the org-wide permission triplet.
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { common, event } from "@dub/types";
import { useEventApi } from "./ApiContext";
import { useEventDetailQuery } from "../hooks/useEventQueries";
import { useAuthStore } from "../contracts/fe2";
import { derivePermissions, type EventPermissions } from "../lib/permissions";
import { eventKeys } from "../lib/queryKeys";

export interface EventContextValue {
  event: event.DubEvent;
  actions: event.ActionSummary[];
  permissions: EventPermissions;
  refresh: () => Promise<void>;
}

const EventContext = React.createContext<EventContextValue | null>(null);

export interface EventContextProviderProps {
  eventId: common.EventId;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  notFound?: React.ReactNode;
}

export function EventContextProvider({ eventId, children, fallback, notFound }: EventContextProviderProps) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useEventDetailQuery(eventId);
  const me = useAuthStore((s) => s.me);
  const authLoading = useAuthStore((s) => s.loading);

  const permissions = React.useMemo(() => derivePermissions(me, authLoading), [me, authLoading]);

  const refresh = React.useCallback(async () => {
    await qc.invalidateQueries({ queryKey: eventKeys.detail(eventId) });
  }, [qc, eventId]);

  const value = React.useMemo<EventContextValue | null>(() => {
    if (!data) return null;
    const { actions, ...ev } = data;
    return { event: ev, actions, permissions, refresh };
  }, [data, permissions, refresh]);

  if (isLoading) return <>{fallback ?? null}</>;
  if (isError || !value) return <>{notFound ?? null}</>;

  return <EventContext.Provider value={value}>{children}</EventContext.Provider>;
}

export function useEventContext(): EventContextValue {
  const ctx = React.useContext(EventContext);
  if (!ctx) throw new Error("useEventContext must be used within EventContextProvider");
  return ctx;
}
