// Top-level chat screen: workspace rail + channel sidebar + active channel +
// (when a thread is open) the right thread pane. In admin-spa the routes in
// feature.tsx drive channel selection via TanStack Router params; standalone we
// keep selection in local state and persist the last channel (design §3).
import { useCallback, useEffect, useState } from "react";
import { SkeletonList, ToastProvider } from "@dub/ui";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import type { Channel } from "../api/contract";
import { getLastChannel, setLastChannel } from "../store/draft";
import type { CreateChannelRequest } from "../api/contract";
import { ChannelList } from "./ChannelList";
import { ChannelPage } from "./ChannelPage";
import { CreateChannelModal } from "./CreateChannelModal";
import styles from "../styles/chat.module.css";

export function ChatApp({ initialChannelId, eventId }: { initialChannelId?: common.ChannelId; eventId?: common.EventId }) {
  const { api, can } = useChatRuntime();
  const unread = useChatStore((s) => s.unread);
  const setUnread = useChatStore((s) => s.setUnread);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [active, setActive] = useState<common.ChannelId | null>(initialChannelId ?? null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const reloadChannels = useCallback(async () => {
    // allSettled (not all): the channel sidebar must render whenever listChannels
    // succeeds, even if the companion unread fetch fails (e.g. a transient 401 /
    // session refresh). Promise.all is fail-fast — one rejection blanked the whole
    // sidebar despite channels loading fine. Unread just degrades to "no badges".
    const [channelsRes, unreadRes] = await Promise.allSettled([api.listChannels(eventId), api.listUnread()]);
    if (channelsRes.status === "rejected") throw channelsRes.reason;
    const list = channelsRes.value;
    setChannels(list);
    if (unreadRes.status === "fulfilled") setUnread(unreadRes.value);
    return list;
  }, [api, eventId, setUnread]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: Channel[] = [];
      try {
        list = await reloadChannels();
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
      if (cancelled) return;
      setActive((cur) => {
        if (cur) return cur;
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
  }, [reloadChannels, eventId]);

  const onSelect = useCallback((channelId: common.ChannelId) => {
    setActive(channelId);
    setLastChannel(channelId);
  }, []);

  const onCreateChannel = useCallback(
    async (req: CreateChannelRequest) => {
      const created = await api.createChannel(req);
      await reloadChannels();
      onSelect(created.id);
    },
    [api, reloadChannels, onSelect],
  );

  return (
    <ToastProvider>
    <div className={`${styles.app} ${threadOpen ? styles.withThread : ""}`} data-app-bleed data-testid="fe6-chat-app">
      {/* leftmost workspace / team rail */}
      <div className={styles.rail} aria-label="ワークスペース">
        <button type="button" className={`${styles.railTile} ${styles.active}`} aria-label="DevHub ワークスペース" title="DevHub">
          D
        </button>
        <button type="button" className={`${styles.railTile} ${styles.ghost}`} aria-label="ワークスペースを追加" title="追加">
          ＋
        </button>
        <div className={styles.railSpacer} />
        <button type="button" className={styles.railIconBtn} aria-label="自分" title="自分">
          🙂
        </button>
      </div>

      <ChannelList
        channels={channels}
        unread={unread}
        activeChannelId={active}
        canCreate={can("chat:create")}
        loading={channelsLoading}
        onSelect={onSelect}
        onCreate={() => setCreateOpen(true)}
      />

      {active ? (
        <ChannelPage
          key={active}
          channelId={active}
          onThreadOpenChange={setThreadOpen}
          onSelectChannel={onSelect}
          onChannelsChanged={() => void reloadChannels()}
        />
      ) : channelsLoading ? (
        // Initial channel fetch: skeleton the main pane too, not just the sidebar.
        <section className={styles.main} data-testid="fe6-main-loading">
          <SkeletonList rows={6} avatar />
        </section>
      ) : (
        <section className={styles.main}>
          <div className={styles.emptyState}>チャネルを選択してください</div>
        </section>
      )}

      <CreateChannelModal open={createOpen} onClose={() => setCreateOpen(false)} onCreate={onCreateChannel} />
    </div>
    </ToastProvider>
  );
}
