// Top-level chat screen: channel list + active channel. In admin-spa the routes
// in feature.tsx drive channel selection via TanStack Router params; standalone we
// keep selection in local state and persist the last channel (design §3).
import { useCallback, useEffect, useState } from "react";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import type { Channel } from "../api/contract";
import { getLastChannel, setLastChannel } from "../store/draft";
import { ChannelList } from "./ChannelList";
import { ChannelPage } from "./ChannelPage";
import styles from "../styles/chat.module.css";

export function ChatApp({ initialChannelId, eventId }: { initialChannelId?: common.ChannelId; eventId?: common.EventId }) {
  const { api, can } = useChatRuntime();
  const unread = useChatStore((s) => s.unread);
  const setUnread = useChatStore((s) => s.setUnread);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<common.ChannelId | null>(initialChannelId ?? null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [list, unreadList] = await Promise.all([api.listChannels(eventId), api.listUnread()]);
      if (cancelled) return;
      setChannels(list);
      setUnread(unreadList);
      setActive((cur) => {
        if (cur) return cur;
        // eventId query resolves to that event's channel (design §2-1 /chat?eventId=)
        if (eventId) {
          const evChannel = list.find((c) => c.eventId === eventId);
          if (evChannel) return evChannel.id;
        }
        const last = getLastChannel();
        if (last && list.some((c) => c.id === last)) return last;
        return list[0]?.id ?? null;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [api, eventId, setUnread]);

  const onSelect = useCallback((channelId: common.ChannelId) => {
    setActive(channelId);
    setLastChannel(channelId);
  }, []);

  return (
    <div className={styles.layout} data-testid="fe6-chat-app">
      <ChannelList
        channels={channels}
        unread={unread}
        activeChannelId={active}
        canCreate={can("chat:create")}
        onSelect={onSelect}
      />
      {active ? (
        <ChannelPage key={active} channelId={active} />
      ) : (
        <section className={styles.main}>
          <div className={styles.dateDivider}>チャネルを選択してください</div>
        </section>
      )}
    </div>
  );
}
