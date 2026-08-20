// Global イベント switcher — the app-shell header's GCP-style project selector.
// It answers "which event am I working in" for the whole shell and lives in the
// header actions row (left of the 9-dot AppLauncher), mounted as the gantt module's
// headerWidget (composition/featureModules → adaptGantt).
//
// ALWAYS visible — the header content is fixed across every route (like GCP's top
// project selector), so the working event is switchable from any app (mail / chat /
// roster …), not only the gantt. On an event-scoped gantt/tasks route the URL param
// is the source of truth for the shown event; elsewhere the label reflects the last
// selected event (localStorage). On select it navigates to the chosen event's gantt
// (its event-scoped workspace) — the URL stays deep-link/contract-safe (`eventId`).
import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { event } from "@dub/types";
import { Menu } from "@dub/ui";
import { useGanttApi } from "./GanttProvider.tsx";
import { loadSelectedEvent, saveSelectedEvent } from "./selectedEventStore.ts";
import styles from "./gantt.module.css";

/** eventId when the path is an event-scoped gantt/tasks route, else null. */
export function eventIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/events\/([^/]+)\/tasks/);
  return m ? m[1]! : null;
}

export function GlobalEventSwitcher(): JSX.Element {
  const api = useGanttApi();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The FULL selectable event catalog (GET /events) — not the Home BFF's curated
  // "upcoming" subset, so every event the user can open a gantt for is switchable.
  const { data } = useQuery({
    queryKey: ["gantt", "event-catalog"],
    queryFn: () => api.events.get<event.ListEventsResponse>(""),
    staleTime: 60_000,
  });
  const events = data?.items ?? [];

  const routeEventId = eventIdFromPath(pathname);
  // Remember the event the user is actually viewing so the label persists after they
  // navigate to another app. Effect (not render) so it never writes during a render.
  useEffect(() => {
    if (routeEventId) saveSelectedEvent(routeEventId);
  }, [routeEventId]);

  // Shown event = the URL's event on a gantt route, else the last selected one. No
  // events[0] default: off a gantt route with no prior pick we prompt to choose
  // rather than fake a selection.
  const currentId = routeEventId ?? loadSelectedEvent() ?? null;
  const current = events.find((e) => e.id === currentId);
  const label = current?.title ?? (events.length === 0 ? "読み込み中…" : "イベントを選択");

  const select = (id: string): void => {
    if (id === currentId) return;
    saveSelectedEvent(id);
    void navigate({ to: `/events/${id}/tasks/gantt` });
  };

  const items = events.map((e) => ({
    id: e.id,
    label: e.title,
    ...(e.id === currentId ? { icon: "check" as const } : {}),
    onSelect: () => select(e.id),
    testId: `fe2-global-event-item-${e.id}`,
  }));

  return (
    <div className={styles.switcher} data-testid="fe2-global-event-switcher">
      <Menu
        testId="fe2-global-event-menu"
        label={label}
        menuLabel="作業するイベントを選択"
        icon="calendar"
        variant="secondary"
        align="start"
        items={items}
      />
    </div>
  );
}

export default GlobalEventSwitcher;
