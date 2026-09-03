// Route wrapper for /chat/channels/$channelId/settings (admin only — gated by
// requiredPermissions: ["chat:moderate"] in feature.tsx).
/// <reference lib="dom" />
import { useEffect, useState } from "react";
import { SkeletonLoader } from "@dub/ui";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import type { Channel } from "../api/contract";
import { ChannelSettingsForm } from "../components/ChannelSettingsForm";

export function ChannelSettingsRoute() {
  const { api } = useChatRuntime();
  const parts = (globalThis.location?.pathname ?? "").split("/").filter(Boolean);
  const idx = parts.indexOf("channels");
  const channelId = (idx >= 0 ? parts[idx + 1] : undefined) as common.ChannelId | undefined;
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    void api.getChannel(channelId).then((res) => {
      if (!cancelled) setChannel(res.channel);
    });
    return () => {
      cancelled = true;
    };
  }, [api, channelId]);

  if (!channel || !channelId)
    return (
      <div data-testid="fe6-channel-settings-loading" style={{ padding: "var(--dub-space-4)" }}>
        <SkeletonLoader lines={5} />
      </div>
    );

  return (
    <ChannelSettingsForm
      channel={channel}
      onSave={async (patch) => {
        const updated = await api.updateChannel(channelId, patch);
        setChannel(updated);
      }}
      onArchiveToggle={async (archived, version) => {
        const updated = await api.updateChannel(channelId, { archived, version });
        setChannel(updated);
      }}
    />
  );
}
