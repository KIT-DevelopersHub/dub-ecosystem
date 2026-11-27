// What the AI side panel is "looking at": the event in the URL (/events/<id>…), else the
// header's selected event while inside the events/gantt apps, else the open app, else ホーム.
import type { NavEntry } from "../../modules/types.tsx";

export type AiPanelTarget =
  | { kind: "event"; eventId: string }
  | { kind: "app"; label: string }
  | { kind: "home" };

const RESERVED_EVENT_SEGMENTS = new Set(["list", "new"]);

/** eventId when the path is under /events/<id>, else null (/events, /events/list are not). */
export function eventIdFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/events\/([^/?#]+)/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  return RESERVED_EVENT_SEGMENTS.has(id) ? null : id;
}

export function resolveAiPanelTarget(
  pathname: string,
  navEntries: NavEntry[],
  selectedEventId: string | null,
): AiPanelTarget {
  const fromPath = eventIdFromPathname(pathname);
  if (fromPath) return { kind: "event", eventId: fromPath };
  if (pathname === "/" || pathname === "") return selectedEventId ? { kind: "event", eventId: selectedEventId } : { kind: "home" };
  // Longest matching app path wins (e.g. /events over /).
  const app = [...navEntries]
    .filter((e) => e.path !== "/" && (pathname === e.path || pathname.startsWith(`${e.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (app?.path === "/events" && selectedEventId) return { kind: "event", eventId: selectedEventId };
  return app ? { kind: "app", label: app.label } : { kind: "home" };
}
