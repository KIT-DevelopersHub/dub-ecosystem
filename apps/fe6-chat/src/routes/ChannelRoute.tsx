// Route wrapper for /chat/channels/$channelId. admin-spa passes the param; here we
// read the last path segment as a standalone fallback.
/// <reference lib="dom" />
import { ChatApp } from "../components/ChatApp";

export function ChannelRoute() {
  const parts = (globalThis.location?.pathname ?? "").split("/").filter(Boolean);
  const idx = parts.indexOf("channels");
  const channelId = idx >= 0 ? parts[idx + 1] : undefined;
  return <ChatApp initialChannelId={channelId} />;
}
