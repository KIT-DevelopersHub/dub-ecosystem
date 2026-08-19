// Global イベント switcher — the app-shell header's GCP-style project selector.
// It answers "which event am I working in" for the whole shell and lives in the
// header actions row (left of the bell/settings icon group), mounted as the gantt
// module's headerWidget (composition/featureModules → adaptGantt).
//
// Contextual by design (designer judgment, review #7): only tasks/gantt are
// event-scoped in this shell, so the selector shows ONLY on the gantt landing and
// the event-scoped gantt/tasks routes. Rendering it on unrelated apps (mail, chat,
// roster) would be noise. On select it navigates the URL to the chosen event's
// gantt — the URL stays the single source of truth (deep-link/contract-safe:
// `eventId` param), and localStorage remembers the pick for the next launcher entry.
import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { event } from "@dub/types";
import { Menu } from "@dub/ui";
import { useGanttApi } from "./GanttProvider.tsx";
import { loadSelectedEvent, saveSelectedEvent } from "./selectedEventStore.ts";
import styles from "./gantt.module.css";

/** eventId when the path is an event-scoped gantt/tasks route, else null. */
function eventIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/events\/([^/]+)\/tasks/);
  return m ? m[1]! : null;
}

/** Whether the switcher should show for this route (gantt context only). */
export function isGanttContext(pathname: string): boolean {
  return pathname === "/gantt" || pathname.startsWith("/gantt/") || eventIdFromPath(pathname) !== null;
}

export function GlobalEventSwitcher(): JSX.Element | null {
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
  // Remember the event the user is actually viewing so the launcher / landing can
  // resume it later. Effect (not render) so it never writes during another render.
  useEffect(() => {
    if (routeEventId) saveSelectedEvent(routeEventId);
  }, [routeEventId]);

  if (!isGanttContext(pathname)) return null;

  const currentId = routeEventId ?? loadSelectedEvent() ?? events[0]?.id ?? null;
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
      <span className={styles.eyebrow}>イベント</span>
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
