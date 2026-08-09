// Deep-link resolver (§2-4). App Links (https://developershub.jp/...) is canonical;
// custom scheme dub:// is the fallback (devhub:// retired). Same route table the
// Android NavHost consumes.
import { APP_LINK_HOST, DEEP_LINK_SCHEME } from "./config";

export type Route =
  | { screen: "home" } // S2
  | { screen: "eventDetail"; eventId: string } // S4
  | { screen: "eventGantt"; eventId: string } // S11 (per-event gantt view)
  | { screen: "taskDetail"; taskId: string } // S6
  | { screen: "inbox" } // S7
  | { screen: "chat" } // S10 channel list
  | { screen: "chatChannel"; channelId: string } // S10 channel
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

  const [head, a, b] = segments;
  switch (head) {
    case "home":
      return { screen: "home" };
    case "inbox":
      return { screen: "inbox" };
    case "events":
      if (!a) return { screen: "unknown", raw };
      // /events/{id}/gantt -> event's gantt view; /events/{id} -> detail (S11/S4)
      return b === "gantt"
        ? { screen: "eventGantt", eventId: a }
        : { screen: "eventDetail", eventId: a };
    case "gantt":
      // /gantt/{eventId} shorthand (App Link + dub://gantt/{eventId})
      return a ? { screen: "eventGantt", eventId: a } : { screen: "unknown", raw };
    case "tasks":
      return a ? { screen: "taskDetail", taskId: a } : { screen: "unknown", raw };
    case "chat":
      // /chat -> list; /chat/channels/{id} (canonical) or /chat/{id} (shorthand)
      if (!a) return { screen: "chat" };
      if (a === "channels") return b ? { screen: "chatChannel", channelId: b } : { screen: "unknown", raw };
      return { screen: "chatChannel", channelId: a };
    default:
      return { screen: "unknown", raw };
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}
