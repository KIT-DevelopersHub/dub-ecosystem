// Deep-link resolver (§2-4). App Links (https://developershub.jp/...) is canonical;
// custom scheme dub:// is the fallback (devhub:// retired). Same route table the
// Android NavHost consumes.
import { APP_LINK_HOST, DEEP_LINK_SCHEME } from "./config";

export type Route =
  | { screen: "home" } // S2
  | { screen: "eventDetail"; eventId: string } // S4
  | { screen: "taskDetail"; taskId: string } // S6
  | { screen: "inbox" } // S7
  | { screen: "unknown"; raw: string };

/** Parse an App Link or dub:// fallback into a Route. Unknown -> {screen:"unknown"}. */
export function parseDeepLink(raw: string): Route {
  let segments: string[];
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") {
      if (url.hostname !== APP_LINK_HOST) return { screen: "unknown", raw };
      segments = splitPath(url.pathname);
    } else if (url.protocol === `${DEEP_LINK_SCHEME}:`) {
      // dub://events/{id} -> host="events", path="/{id}"
      segments = [url.hostname, ...splitPath(url.pathname)].filter((s) => s.length > 0);
    } else {
      return { screen: "unknown", raw };
    }
  } catch {
    return { screen: "unknown", raw };
  }

  const [head, id] = segments;
  switch (head) {
    case "home":
      return { screen: "home" };
    case "inbox":
      return { screen: "inbox" };
    case "events":
      return id ? { screen: "eventDetail", eventId: id } : { screen: "unknown", raw };
    case "tasks":
      return id ? { screen: "taskDetail", taskId: id } : { screen: "unknown", raw };
    default:
      return { screen: "unknown", raw };
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}
