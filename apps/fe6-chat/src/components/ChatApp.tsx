// Top-level chat screen: workspace rail + channel sidebar + active channel +
// (when a thread is open) the right thread pane. In admin-spa the routes in
// feature.tsx drive channel selection via TanStack Router params; standalone we
// keep selection in local state and persist the last channel (design §3).
import { useCallback, useEffect, useState } from "react";
import { Drawer, Icon, ToastProvider } from "@dub/ui";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import { useIsMobile } from "../hooks/useIsMobile";
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
  const setTeams = useChatStore((s) => s.setTeams);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<common.ChannelId | null>(initialChannelId ?? null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // P21: below the mobile breakpoint the rail+channel-list column becomes a
  // slide-in drawer instead of always-visible grid columns, so the message
  // timeline can use the full width. Desktop is unaffected (isMobile stays
  // false and the drawer branch below never renders).
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

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
      const list = await reloadChannels();
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

  // 運営チーム (チーム単位メンションの候補) と自分の所属チームを一度だけ読み込む。
  // member-service が落ちていてもチャットは開けるべきなので、失敗は「チームなし」に倒す。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await api.listMentionTeams().catch(() => ({ teams: [], myTeamIds: [] }));
      if (cancelled) return;
      setTeams(res.teams, res.myTeamIds);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, setTeams]);

  const onSelect = useCallback((channelId: common.ChannelId) => {
    setActive(channelId);
    setLastChannel(channelId);
    // Picking a channel from the mobile drawer should dismiss it immediately —
    // otherwise the user has to also tap the backdrop/close button afterwards.
    setMobileNavOpen(false);
  }, []);

  const onCreateChannel = useCallback(
    async (req: CreateChannelRequest) => {
      const created = await api.createChannel(req);
      await reloadChannels();
      onSelect(created.id);
    },
    [api, reloadChannels, onSelect],
  );

  // Shared rail + channel list markup, reused inline on desktop and inside the
  // mobile drawer — keeping one definition avoids the two surfaces drifting.
  const nav = (
    <>
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
        onSelect={onSelect}
        onCreate={() => setCreateOpen(true)}
        onCloseMobile={isMobile ? () => setMobileNavOpen(false) : undefined}
      />
    </>
  );

  return (
    <ToastProvider>
    <div className={`${styles.app} ${threadOpen ? styles.withThread : ""}`} data-app-bleed data-testid="fe6-chat-app">
      {isMobile ? (
        <Drawer
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          side="left"
          hideHeader
          title="チャネル一覧"
          testId="fe6-mobile-nav-drawer"
        >
          {nav}
        </Drawer>
      ) : (
        nav
      )}

      {active ? (
        <ChannelPage
          key={active}
          channelId={active}
          onThreadOpenChange={setThreadOpen}
          onSelectChannel={onSelect}
          onChannelsChanged={() => void reloadChannels()}
          onOpenMobileNav={isMobile ? () => setMobileNavOpen(true) : undefined}
        />
      ) : (
        <section className={styles.main}>
          {isMobile && (
            <button
              type="button"
              className={styles.mobileMenuBtn}
              onClick={() => setMobileNavOpen(true)}
              aria-label="チャネル一覧を開く"
              title="チャネル一覧"
              data-testid="fe6-mobile-nav-open"
            >
              <Icon name="menu" size="sm" />
            </button>
          )}
          <div className={styles.emptyState}>チャネルを選択してください</div>
        </section>
      )}

      <CreateChannelModal open={createOpen} onClose={() => setCreateOpen(false)} onCreate={onCreateChannel} />
    </div>
    </ToastProvider>
  );
}
