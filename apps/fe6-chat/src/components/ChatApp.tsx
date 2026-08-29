// Top-level chat screen: workspace rail + channel sidebar + active channel +
// (when a thread is open) the right thread pane. In admin-spa the routes in
// feature.tsx drive channel selection via TanStack Router params; standalone we
// keep selection in local state and persist the last channel (design §3).
import { useCallback, useEffect, useRef, useState } from "react";
import { ToastProvider } from "@dub/ui";
import type { common } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import type { Channel } from "../api/contract";
import { getLastChannel, setLastChannel } from "../store/draft";
import type { CreateChannelRequest } from "../api/contract";
import { getPresence, setPresence, type Presence } from "../lib/presence";
import { ChannelList } from "./ChannelList";
import { ChannelPage } from "./ChannelPage";
import { CreateChannelModal } from "./CreateChannelModal";
import styles from "../styles/chat.module.css";

const PRESENCE_LABELS: Record<Presence, string> = { online: "オンライン", away: "退席中", offline: "オフライン" };

/** Bottom-of-rail self control: shows own presence and lets the user set it (the dot
 *  it drives is the same presence source the member roster reads — a real toggle, not
 *  decoration). Closes on outside click / Esc. */
function RailSelfMenu({ userId }: { userId: common.UserId }) {
  const [open, setOpen] = useState(false);
  const [presence, setLocalPresence] = useState<Presence>(() => {
    const p = getPresence(userId);
    return p === "offline" ? "online" : p;
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPresence({ [userId]: presence });
  }, [userId, presence]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={styles.railSelfWrap} ref={ref}>
      <button
        type="button"
        className={styles.railIconBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`自分のステータス: ${PRESENCE_LABELS[presence]}`}
        title={`自分 · ${PRESENCE_LABELS[presence]}`}
        data-testid="fe6-rail-self"
        onClick={() => setOpen((o) => !o)}
      >
        🙂
        <span className={`${styles.presenceDot} ${styles[presence]} ${styles.railSelfDot}`} aria-hidden />
      </button>
      {open && (
        <div className={styles.railSelfMenu} role="menu" data-testid="fe6-rail-self-menu">
          <div className={styles.railSelfMenuTitle}>ステータス</div>
          {(["online", "away"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={presence === p}
              className={styles.railSelfMenuItem}
              onClick={() => {
                setLocalPresence(p);
                setOpen(false);
              }}
            >
              <span className={`${styles.presenceDot} ${styles[p]}`} aria-hidden />
              <span>{PRESENCE_LABELS[p]}</span>
              {presence === p && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatApp({ initialChannelId, eventId }: { initialChannelId?: common.ChannelId; eventId?: common.EventId }) {
  const { api, can, currentUserId } = useChatRuntime();
  const unread = useChatStore((s) => s.unread);
  const setUnread = useChatStore((s) => s.setUnread);
  const [channels, setChannels] = useState<Channel[]>([]);
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
        <div className={`${styles.railTile} ${styles.active}`} aria-current="true" title="DevHub ワークスペース">
          D
        </div>
        <div className={styles.railSpacer} />
        <RailSelfMenu userId={currentUserId} />
      </div>

      <ChannelList
        channels={channels}
        unread={unread}
        activeChannelId={active}
        canCreate={can("chat:create")}
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
