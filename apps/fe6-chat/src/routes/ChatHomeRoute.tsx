// Route wrapper: /chat and /chat?eventId= resolution口 (design §2-1). In admin-spa
// the router injects the eventId search param; here it reads window.location.
/// <reference lib="dom" />
import { ChatApp } from "../components/ChatApp";

export function ChatHomeRoute() {
  const eventId = new URLSearchParams(globalThis.location?.search ?? "").get("eventId") ?? undefined;
  return <ChatApp eventId={eventId} />;
}
