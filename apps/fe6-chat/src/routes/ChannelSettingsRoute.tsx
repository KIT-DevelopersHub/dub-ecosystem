// Route wrapper for /chat/channels/$channelId/settings (gated by
// requiredPermissions: ["chat:moderate"] in feature.tsx). Opens the channel with its
// details modal on the 設定 tab, so there is one settings UI (ChannelDetails).
/// <reference lib="dom" />
import { ChatApp } from "../components/ChatApp";

export function ChannelSettingsRoute() {
  const parts = (globalThis.location?.pathname ?? "").split("/").filter(Boolean);
  const idx = parts.indexOf("channels");
  const channelId = idx >= 0 ? parts[idx + 1] : undefined;
  return <ChatApp initialChannelId={channelId} initialDetailsTab="settings" />;
}
