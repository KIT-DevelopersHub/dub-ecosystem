// deeplink — Universal Links (https) primary + `dub://` fallback parsing
// (design §2-3: "Universal Links 本命 + dub:// フォールバック・devhub:// は廃止").
// Resolves a URL to an in-app route the AppShell can navigate to.
export type RouteName = "home" | "event" | "action" | "task" | "inbox" | "profile" | "chat";

export interface Route {
  name: RouteName;
  params: Record<string, string>;
}

const HOME: Route = { name: "home", params: {} };

const UNIVERSAL_HOSTS: ReadonlySet<string> = new Set(["m.developershub.jp", "developershub.jp"]);
const DUB_SCHEME = "dub:";

/** Map a path segment list to a route; unknown paths fall back to home. */
function routeFromSegments(segments: string[]): Route {
  const [head, id] = segments;
  switch (head) {
    case undefined:
    case "":
    case "home":
      return HOME;
    case "events":
      return id ? { name: "event", params: { eventId: id } } : HOME;
    case "actions":
      return id ? { name: "action", params: { actionId: id } } : HOME;
    case "tasks":
      return id ? { name: "task", params: { taskId: id } } : HOME;
    case "inbox":
      return { name: "inbox", params: {} };
    case "chat":
      return id ? { name: "chat", params: { channelId: id } } : { name: "chat", params: {} };
    case "profile":
    case "me":
      return { name: "profile", params: {} };
    default:
      return HOME;
  }
}

/** Parse an https Universal Link or a dub:// deeplink into a Route. */
export function parseDeepLink(raw: string): Route {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return HOME;
  }

  if (u.protocol === DUB_SCHEME) {
    // dub://events/<id>  -> host="events", pathname="/<id>"
    const host = u.hostname;
    const rest = u.pathname.split("/").filter(Boolean);
    return routeFromSegments([host, ...rest]);
  }

  if ((u.protocol === "https:" || u.protocol === "http:") && UNIVERSAL_HOSTS.has(u.hostname)) {
    return routeFromSegments(u.pathname.split("/").filter(Boolean));
  }

  // devhub:// and any foreign origin are ignored (retired scheme / safety).
  return HOME;
}
