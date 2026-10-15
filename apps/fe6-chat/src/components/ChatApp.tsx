// Top-level chat screen: workspace rail + channel sidebar + active channel +
// (when a thread is open) the right thread pane. In admin-spa the routes in
// feature.tsx drive channel selection via TanStack Router params; standalone we
// keep selection in local state and persist the last channel (design §3).
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, Drawer, Icon, ToastProvider } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Channel, ChatSection } from "../api/contract";
import { getLastChannel, setLastChannel } from "../store/draft";
import type { CreateChannelRequest } from "../api/contract";
import { ChannelList } from "./ChannelList";
import { ChannelPage } from "./ChannelPage";
import type { ChannelDetailsTab } from "./ChannelDetails";
import { CreateChannelModal } from "./CreateChannelModal";
import { NewDmModal } from "./NewDmModal";
import { SectionNameModal } from "./SectionNameModal";
import { SlackImportModal } from "./slack-import/SlackImportModal";
import { useChatSections } from "../hooks/useChatSections";
import { channelLabel } from "../lib/dm";
import styles from "../styles/chat.module.css";

type ChatAppProps = { initialChannelId?: common.ChannelId; eventId?: common.EventId; initialDetailsTab?: ChannelDetailsTab };

type SectionDialog = { mode: "create"; assignChannelId?: common.ChannelId } | { mode: "rename"; section: ChatSection };

// ToastProvider wraps the body so hooks in it (sections, delete) can toast.
export function ChatApp(props: ChatAppProps) {
  return (
    <ToastProvider>
      <ChatAppBody {...props} />
    </ToastProvider>
  );
}

function ChatAppBody({ initialChannelId, eventId, initialDetailsTab }: ChatAppProps) {
  const { api, can, currentUserId } = useChatRuntime();
  const unread = useChatStore((s) => s.unread);
  const setUnread = useChatStore((s) => s.setUnread);
  const setTeams = useChatStore((s) => s.setTeams);
  const dropChannel = useChatStore((s) => s.dropChannel);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const sections = useChatSections(api);
  const [sectionDialog, setSectionDialog] = useState<SectionDialog | null>(null);
  const [pendingSectionDelete, setPendingSectionDelete] = useState<ChatSection | null>(null);
  const [active, setActive] = useState<common.ChannelId | null>(initialChannelId ?? null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Same keys chat-service's POLICY_TABLE requires for /chat/slack-import/* (admin/maintainer).
  const canImport = can("app:chat:edit") && can("chat:create") && can("chat:moderate");
  // DM peers' display names (a DM is labelled by "the other side").
  const [dmUsers, setDmUsers] = useState<Record<common.UserId, identity.UserSummary>>({});
  const [dmUsersFailed, setDmUsersFailed] = useState(false);
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
      let list: Channel[];
      try {
        list = await reloadChannels();
      } finally {
        if (!cancelled) setChannelsLoaded(true);
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

  useEffect(() => {
    const ids = new Set<common.UserId>();
    for (const c of channels) if (c.type === "dm") for (const id of c.memberIds ?? []) ids.add(id);
    const missing = [...ids].filter((id) => !(id in dmUsers));
    if (missing.length === 0) return;
    let cancelled = false;
    void api
      .resolveUsers(missing)
      .then((summaries) => {
        if (cancelled) return;
        setDmUsersFailed(false);
        setDmUsers((prev) => {
          const next = { ...prev };
          for (const u of summaries) next[u.id] = u;
          // Unknown ids still settle (as themselves) so a row never skeletons forever.
          for (const id of missing) next[id] ??= { id, displayName: id, avatarUrl: null };
          return next;
        });
      })
      .catch(() => !cancelled && setDmUsersFailed(true));
    return () => {
      cancelled = true;
    };
  }, [api, channels, dmUsers]);

  const labelOf = useCallback(
    (c: Channel) => channelLabel(c, currentUserId, (id) => dmUsers[id]) ?? (dmUsersFailed ? c.name : null),
    [currentUserId, dmUsers, dmUsersFailed],
  );

  const onStartDm = useCallback(
    async (peers: identity.UserSummary[]) => {
      setDmUsers((prev) => {
        const next = { ...prev };
        for (const u of peers) next[u.id] = u;
        return next;
      });
      const created = await api.createChannel({
        type: "dm",
        visibility: "private",
        name: "DM", // labelled per viewer from memberIds; the server stores a neutral name
        memberIds: peers.map((u) => u.id),
      });
      await reloadChannels();
      onSelect(created.id);
    },
    [api, reloadChannels, onSelect],
  );

  const onCreateChannel = useCallback(
    async (req: CreateChannelRequest) => {
      const created = await api.createChannel(req);
      await reloadChannels();
      onSelect(created.id);
    },
    [api, reloadChannels, onSelect],
  );

  // Hard-deleted channel: drop it locally right away, move off it, then resync.
  const onChannelDeleted = useCallback(
    (deletedId: common.ChannelId) => {
      dropChannel(deletedId);
      const rest = channels.filter((c) => c.id !== deletedId);
      setChannels(rest);
      if (active === deletedId) {
        const next = rest.find((c) => !c.archived) ?? rest[0];
        if (next) setLastChannel(next.id);
        setActive(next?.id ?? null);
        setThreadOpen(false);
      }
      void reloadChannels().catch(() => undefined);
    },
    [channels, active, dropChannel, reloadChannels],
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
        labelOf={labelOf}
        onNewDm={can("chat:create") ? () => setNewDmOpen(true) : undefined}
        onCloseMobile={isMobile ? () => setMobileNavOpen(false) : undefined}
        loading={!channelsLoaded || !sections.loaded}
        sections={sections.sections}
        assignments={sections.assignments}
        sectionActions={{
          onCreate: (assignChannelId) => setSectionDialog({ mode: "create", ...(assignChannelId ? { assignChannelId } : {}) }),
          onRename: (section) => setSectionDialog({ mode: "rename", section }),
          onDelete: setPendingSectionDelete,
          onMove: sections.move,
        }}
        {...(canImport ? { onImport: () => setImportOpen(true) } : {})}
      />
    </>
  );

  return (
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
          onChannelDeleted={onChannelDeleted}
          onOpenMobileNav={isMobile ? () => setMobileNavOpen(true) : undefined}
          sections={{
            items: sections.sections,
            currentSectionId: sections.assignments[active] ?? null,
            onMove: (sectionId) => sections.move(active, sectionId),
          }}
          {...(initialDetailsTab && active === initialChannelId ? { initialDetailsTab } : {})}
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
      <SlackImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void reloadChannels().catch(() => undefined)}
        onOpenChannel={(channelId) => {
          setImportOpen(false);
          void reloadChannels()
            .catch(() => undefined)
            .then(() => onSelect(channelId));
        }}
      />
      <NewDmModal open={newDmOpen} onClose={() => setNewDmOpen(false)} onStart={onStartDm} />
      <SectionNameModal
        open={sectionDialog !== null}
        title={sectionDialog?.mode === "rename" ? "セクション名を変更" : "セクションを作成"}
        submitLabel={sectionDialog?.mode === "rename" ? "変更" : "作成"}
        initialName={sectionDialog?.mode === "rename" ? sectionDialog.section.name : ""}
        onSubmit={(name) => {
          if (sectionDialog?.mode === "rename") sections.rename(sectionDialog.section.id, name);
          else sections.create(name, sectionDialog?.assignChannelId);
        }}
        onClose={() => setSectionDialog(null)}
      />
      <ConfirmDialog
        open={pendingSectionDelete !== null}
        title={`セクション「${pendingSectionDelete?.name ?? ""}」を削除しますか？`}
        message="チャンネルは削除されず、元の場所に戻ります。"
        confirmLabel="削除する"
        danger
        onConfirm={() => {
          if (pendingSectionDelete) sections.remove(pendingSectionDelete.id);
          setPendingSectionDelete(null);
        }}
        onCancel={() => setPendingSectionDelete(null)}
        testId="fe6-section-delete-confirm"
      />
    </div>
  );
}
