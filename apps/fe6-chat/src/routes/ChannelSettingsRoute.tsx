// Route wrapper for /chat/channels/$channelId/settings (admin only — gated by
// requiredPermissions: ["chat:moderate"] in feature.tsx). Delete-only roles reach
// delete via the in-chat settings modal instead (ChannelPage).
/// <reference lib="dom" />
import { useEffect, useState } from "react";
import { useToast } from "@dub/ui";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import type { Channel } from "../api/contract";
import { ChannelSettingsForm } from "../components/ChannelSettingsForm";
import { ChatApiError } from "../api/client";
import { mapChatError } from "../lib/errors";

export function ChannelSettingsRoute() {
  const { api, can } = useChatRuntime();
  const { show } = useToast();
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

  if (!channel || !channelId) return <div>読み込み中…</div>;

  const onDelete = async () => {
    try {
      await api.deleteChannel(channelId);
    } catch (err) {
      const code = err instanceof ChatApiError ? err.code : "INTERNAL";
      show({ kind: "error", title: "チャンネルを削除できませんでした", description: mapChatError(code).message });
      throw err;
    }
    show({ kind: "success", title: `#${channel.name} を削除しました` });
    // The channel no longer exists: leave its settings page for the chat home.
    globalThis.location?.assign("/chat");
  };

  return (
    <ChannelSettingsForm
      channel={channel}
      {...(can("chat:delete_channel") && channel.type !== "dm" ? { onDelete } : {})}
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
