/// <reference lib="dom" />
// Container: wires channel detail + timeline + composer + connection/archived
// banner + read tracking for one channel, plus the right-hand thread pane, the
// members/pins popovers, workspace search, message edit, attachments, and the
// Slack-style channel details modal (概要 / メンバー / 設定). The main section and the ThreadPane are returned as
// sibling fragment children so both land as columns of the ChatApp grid.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, Drawer, useToast } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import { useChannelView } from "../hooks/useChannelView";
import { useIsMobile } from "../hooks/useIsMobile";
import { ReadTracker } from "../store/read-tracker";
import { newClientTempId } from "../lib/ulid";
import { mapChatError } from "../lib/errors";
import { ChatApiError, IDENTITY_BATCH_MAX } from "../api/client";
import type { Attachment, Channel, ChannelMember, Message, SearchHit, TeamSummary } from "../api/contract";
import { extractMentions, type MentionCandidate } from "../lib/mentions";
import { ChannelHeader } from "./ChannelHeader";
import { ChannelDetails, type ChannelDetailsSections, type ChannelDetailsTab } from "./ChannelDetails";
import { MessageTimeline } from "./MessageTimeline";
import { MessageComposer } from "./MessageComposer";
import { ConnectionBanner } from "./ConnectionBanner";
import { SearchResults } from "./SearchResults";
import { ThreadPane } from "./ThreadPane";
import { ForwardMessageModal } from "./ForwardMessageModal";
import { MessageActionsContext, type MessageActions } from "./MessageActions";
import { MessageLookupContext, type MessageLookup } from "./MessageUnfurl";
import { channelHandle, channelLabel } from "../lib/dm";
import { toPlainMentions } from "../lib/mentions";
import { countUnreadAfter, messagePermalink, unreadMarkerFor, type MessageLink } from "../lib/forward";
import { formatDue, reminderDueAt, useMessagePrefs, type SavedMessageRef } from "../lib/message-prefs";
import styles from "../styles/chat.module.css";

const MAX_MENTION_CANDIDATES = 8;
const MAX_TEAM_CANDIDATES = 3;

// A jump into another channel (後で / message link card): remembered across the channel
// switch (ChannelPage remounts per channel) and consumed like a ?message= deep link.
let pendingJump: { messageId: string; threadRootId: string | null } | null = null;

/** Ask the next ChannelPage mount to scroll to (and flash) this message. */
export function requestMessageJump(messageId: common.MessageId, threadRootId: common.MessageId | null = null): void {
  pendingJump = { messageId, threadRootId };
}

export function ChannelPage({
  channelId,
  onThreadOpenChange,
  onSelectChannel,
  onChannelsChanged,
  onChannelDeleted,
  onOpenMobileNav,
  sections,
  initialDetailsTab,
  forwardTargets = [],
  resolveChannelName,
}: {
  channelId: common.ChannelId;
  onThreadOpenChange?: (open: boolean) => void;
  onSelectChannel?: (channelId: common.ChannelId) => void;
  onChannelsChanged?: () => void;
  // Fired after a successful hard delete so ChatApp can move off the channel.
  onChannelDeleted?: (channelId: common.ChannelId) => void;
  // Hamburger callback for the mobile channel-list drawer (P21) — forwarded to
  // ChannelHeader, which only shows the button under the mobile breakpoint.
  onOpenMobileNav?: () => void;
  // Personal sidebar section picker shown in the details 設定 tab.
  sections?: ChannelDetailsSections;
  // Open the details modal on mount (legacy /chat/channels/:id/settings deep link).
  initialDetailsTab?: ChannelDetailsTab;
  // 転送先の候補 (サイドバーと同じ表示名) と、リンク展開カードのチャンネル名解決。
  forwardTargets?: { id: common.ChannelId; label: string; archived: boolean }[];
  resolveChannelName?: (id: common.ChannelId) => string | undefined;
}) {
  const { api, can, currentUserId } = useChatRuntime();
  const { show } = useToast();
  // 「新しい返信の通知を受け取る」: a reply by someone else to a followed message.
  const follows = useMessagePrefs((s) => s.follows);
  const followsRef = useRef(follows);
  followsRef.current = follows;
  // Already reading that thread in the pane: no toast for it.
  const openThreadIdRef = useRef<common.MessageId | null>(null);
  const view = useChannelView(channelId, {
    onEvent: (e) => {
      if (e.kind !== "message.created" || !e.threadRootId || e.authorId === currentUserId) return;
      if (!followsRef.current.includes(e.threadRootId) || openThreadIdRef.current === e.threadRootId) return;
      show({ kind: "info", title: "フォロー中のスレッドに新しい返信があります", description: e.body.slice(0, 80) });
    },
  });
  const markRead = useChatStore((s) => s.markRead);
  const setChannelUnread = useChatStore((s) => s.setChannelUnread);
  const bookmarks = useMessagePrefs((s) => s.bookmarks);
  const toggleBookmarkPref = useMessagePrefs((s) => s.toggleBookmark);
  const addReminderPref = useMessagePrefs((s) => s.addReminder);
  const toggleFollowPref = useMessagePrefs((s) => s.toggleFollow);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  // 運営チーム (チーム単位メンション) は ChatApp が一度だけ読み込み store に載せる。
  const teams = useChatStore((s) => s.teams);
  const myTeamIds = useChatStore((s) => s.myTeamIds);
  const teamsLoaded = useChatStore((s) => s.teamsLoaded);
  const isMobile = useIsMobile();

  const [channel, setChannel] = useState<Channel | null>(null);
  const [membership, setMembership] = useState<ChannelMember | null>(null);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [users, setUsers] = useState<Record<common.UserId, identity.UserSummary>>({});
  const [composerError, setComposerError] = useState<string | null>(null);
  const [thread, setThread] = useState<Message | null>(null);
  const [pinned, setPinned] = useState<Message[]>([]);
  const [detailsTab, setDetailsTab] = useState<ChannelDetailsTab | null>(initialDetailsTab ?? null);
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);

  // search state (workspace-wide)
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const canModerate = can("chat:moderate") || membership?.role === "admin";
  // Hard delete is decided by the key alone (no channel-admin fallback); DMs never.
  const canDelete = can("chat:delete_channel") && channel !== null && channel.type !== "dm";
  const pinnedIds = useMemo(() => new Set(pinned.map((m) => m.id)), [pinned]);

  useEffect(() => {
    setThread(null);
    setSearchQuery("");
    setSearchResults([]);
  }, [channelId]);

  useEffect(() => {
    onThreadOpenChange?.(thread !== null);
    openThreadIdRef.current = thread?.id ?? null;
  }, [thread, onThreadOpenChange]);

  // channel detail + members + pins
  useEffect(() => {
    let cancelled = false;
    void api.getChannel(channelId).then((res) => {
      if (cancelled) return;
      setChannel(res.channel);
      setMembership(res.membership);
    });
    void api
      .listMembers(channelId)
      .then((m) => !cancelled && setMembers(m))
      .finally(() => !cancelled && setMembersLoaded(true));
    void api.listPinned(channelId).then((p) => !cancelled && setPinned(p));
    return () => {
      cancelled = true;
    };
  }, [api, channelId]);

  // resolve author / member / @-mentioned display names in batch as they appear.
  // Ids the roster could not return are remembered so they are not refetched forever.
  const unresolvable = useRef(new Set<common.UserId>());
  useEffect(() => {
    // Drop null authorIds (system posts have no author to resolve).
    const authorIds = view.state.messages.map((m) => m.authorId).filter((id): id is common.UserId => id !== null);
    const mentionIds = [...view.state.messages, ...pinned].flatMap((m) => extractMentions(m.body));
    const ids = new Set<common.UserId>([...authorIds, ...mentionIds, ...members.map((m) => m.userId)]);
    const missing = [...ids].filter((id) => !(id in users) && !unresolvable.current.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void api.resolveUsers(missing).then((summaries) => {
      if (cancelled) return;
      const batch = missing.slice(0, IDENTITY_BATCH_MAX);
      const found = new Set(summaries.map((u) => u.id));
      for (const id of batch) if (!found.has(id)) unresolvable.current.add(id);
      setUsers((prev) => {
        const next = { ...prev };
        for (const u of summaries) next[u.id] = u;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, view.state.messages, pinned, members, users]);

  // debounced workspace search
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const handle = globalThis.setTimeout(() => {
      void api.searchMessages({ q }).then((hits) => {
        setSearchResults(hits);
        setSearchLoading(false);
      });
    }, 200);
    return () => globalThis.clearTimeout(handle);
  }, [api, searchQuery]);

  // read tracking
  const tracker = useRef<ReadTracker | null>(null);
  useEffect(() => {
    const t = new ReadTracker({
      send: (lastReadMessageId) => {
        void api.updateReadState({ channelId, lastReadMessageId });
        markRead(channelId, lastReadMessageId);
      },
      isVisible: () => globalThis.document?.visibilityState !== "hidden",
      setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
      clearTimer: (h) => globalThis.clearTimeout(h),
    });
    tracker.current = t;
    return () => {
      t.dispose();
      tracker.current = null;
    };
  }, [api, channelId, markRead]);

  const newestId = view.state.messages[view.state.messages.length - 1]?.id;
  // 「未読にする」 holds until the user leaves the channel (Slack), so new arrivals
  // must not auto-read it back. ChannelPage remounts per channel, resetting this.
  const manualUnreadRef = useRef(false);
  useEffect(() => {
    if (newestId && !manualUnreadRef.current) tracker.current?.observeBottom(newestId);
  }, [newestId]);

  const resolveUser = useCallback((id: common.UserId) => users[id], [users]);
  const searchUsers = useCallback((q: string) => api.searchUsers(q), [api]);
  // 読み込み中は中立の「チーム」表記にして、生の team_01J… が一瞬見える(データ無しと
  // 区別が付かない)状態を避ける。読み込み後も解決できない = 消えたチーム -> id のまま。
  const resolveTeam = useCallback(
    (id: string): TeamSummary | undefined =>
      teams.find((t) => t.id === id) ?? (teamsLoaded ? undefined : { id, key: "", name: "チーム" }),
    [teams, teamsLoaded],
  );
  // @-候補は「チーム → 個人」の順。チームは母数が少なく狙って打つものなので先頭に出す
  // (法人チーム / 統括チームのように「そのチーム全員へ」を一発で選べる)。
  const resolveMentionCandidates = useCallback(
    (query: string): MentionCandidate[] => {
      const q = query.toLowerCase();
      // チーム枠は最大3 (残りは必ず人に残す): "@" だけ打った時に全チームが候補を埋め、
      // 従来の人メンションが押し出される退行を防ぐ。
      const teamHits: MentionCandidate[] = teams
        .filter((t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
        .slice(0, MAX_TEAM_CANDIDATES)
        .map((t) => ({ kind: "team", id: t.id, label: t.name, color: t.color ?? null }));
      const userHits: MentionCandidate[] = Object.values(users)
        .filter((u) => u.displayName.toLowerCase().includes(q))
        .slice(0, MAX_MENTION_CANDIDATES - teamHits.length)
        .map((u) => ({ kind: "user", id: u.id, label: u.displayName, avatarUrl: u.avatarUrl }));
      return [...teamHits, ...userHits];
    },
    [teams, users],
  );

  const onSend = useCallback(
    async (body: string, attachments?: Attachment[]) => {
      setComposerError(null);
      try {
        await view.send(body, attachments ? { attachments } : undefined);
      } catch (err) {
        const code = err instanceof ChatApiError ? err.code : "INTERNAL";
        setComposerError(mapChatError(code).message);
      }
    },
    [view],
  );

  const onSubmitEdit = useCallback(
    async (message: Message, body: string) => {
      await view.editMessage(message.id, body, message.version);
    },
    [view],
  );

  // Open the shared confirm gate (core @dub/ui ConfirmDialog) instead of the
  // native browser confirm, so every destructive confirm looks/behaves the same.
  const onDelete = useCallback((message: Message) => setPendingDelete(message), []);

  const confirmDelete = useCallback(() => {
    const message = pendingDelete;
    setPendingDelete(null);
    if (!message) return;
    // Optimistic: the row updates instantly (view.deleteMessage). On failure the
    // hook rolls back (the message reappears) and we surface an error toast.
    void view.deleteMessage(message.id, message.version).catch((err) => {
      const code = err instanceof ChatApiError ? err.code : "INTERNAL";
      show({ kind: "error", title: "メッセージを削除できませんでした", description: mapChatError(code).message });
    });
  }, [pendingDelete, view, show]);

  const onTogglePin = useCallback(
    (message: Message) => {
      void api.togglePin(channelId, message.id).then(setPinned);
    },
    [api, channelId],
  );

  const onUnpin = useCallback(
    (messageId: common.MessageId) => {
      void api.togglePin(channelId, messageId).then(setPinned);
    },
    [api, channelId],
  );

  const jumpToMessage = useCallback((messageId: common.MessageId) => {
    const el = globalThis.document?.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(styles.jumpHighlight ?? "jumpHighlight");
      globalThis.setTimeout(() => el.classList.remove(styles.jumpHighlight ?? "jumpHighlight"), 1600);
    }
  }, []);

  const onSelectSearchHit = useCallback(
    (hit: SearchHit) => {
      setSearchQuery("");
      setSearchResults([]);
      if (hit.channelId !== channelId) {
        onSelectChannel?.(hit.channelId);
      } else {
        jumpToMessage(hit.message.id);
      }
    },
    [channelId, onSelectChannel, jumpToMessage],
  );

  const failToast = useCallback(
    (title: string, err: unknown) => {
      const code = err instanceof ChatApiError ? err.code : "INTERNAL";
      show({ kind: "error", title, description: mapChatError(code).message });
    },
    [show],
  );

  // ?message=<id>[&thread=<root>] (「リンクをコピー」で作ったリンク) — jump once the row
  // is loaded; a thread reply jumps to its root and opens the thread pane.
  const [initialJump] = useState<{ messageId: string; threadRootId: string | null } | null>(() => {
    const q = new URLSearchParams(globalThis.location?.search ?? "");
    const fromUrl = q.get("message");
    const v = pendingJump ?? (fromUrl ? { messageId: fromUrl, threadRootId: q.get("thread") } : null);
    pendingJump = null;
    return v;
  });
  const deepLinkRef = useRef(initialJump);
  useEffect(() => {
    const target = deepLinkRef.current;
    if (!target) return;
    const rowId = target.threadRootId ?? target.messageId;
    const row = view.state.messages.find((m) => m.id === rowId);
    if (!row) return;
    deepLinkRef.current = null;
    if (target.threadRootId) setThread(row);
    globalThis.setTimeout(() => jumpToMessage(rowId as common.MessageId), 0);
  }, [view.state.messages, jumpToMessage]);

  const plainText = useCallback(
    (m: Message) => toPlainMentions(m.body, (id) => users[id]?.displayName, (id) => resolveTeam(id)?.name),
    [users, resolveTeam],
  );
  const refOf = useCallback(
    (m: Message): SavedMessageRef => ({
      messageId: m.id,
      channelId: m.channelId,
      authorId: m.authorId,
      excerpt: plainText(m).slice(0, 140),
      threadRootId: m.threadRootId,
    }),
    [plainText],
  );

  const copyToClipboard = useCallback(
    (text: string, done: string) => {
      const clip = globalThis.navigator?.clipboard;
      if (!clip) {
        show({ kind: "error", title: "コピーできませんでした", description: "このブラウザはクリップボードに対応していません" });
        return;
      }
      clip.writeText(text).then(
        () => show({ kind: "success", title: done }),
        () => show({ kind: "error", title: "コピーできませんでした", description: "ブラウザがクリップボードへの書き込みを許可しませんでした" }),
      );
    },
    [show],
  );

  const messageActions = useMemo<MessageActions>(() => {
    const bookmarked = new Set(bookmarks.map((b) => b.messageId));
    return {
      isBookmarked: (id) => bookmarked.has(id),
      isFollowing: (id) => follows.includes(id),
      // The oldest loaded row with older history unloaded has no known predecessor id;
      // "0" there would mark the whole channel history unread.
      canMarkUnread: (m) =>
        m.threadRootId === null &&
        m.channelId === channelId &&
        (view.state.messages[0]?.id !== m.id || view.state.nextCursor === null),
      // Optimistic: divider + sidebar badge move at once, then the server's count wins.
      markUnread: (m) => {
        const marker = unreadMarkerFor(view.state.messages, m.id);
        manualUnreadRef.current = true;
        tracker.current?.cancel();
        view.setLastRead(marker);
        setChannelUnread({
          channelId,
          lastReadMessageId: marker,
          unreadCount: countUnreadAfter(view.state.messages, marker, currentUserId),
          mentioned: false,
        });
        show({ kind: "success", title: "このメッセージから未読にしました" });
        api
          .updateReadState({ channelId, lastReadMessageId: marker })
          .then(() => api.listUnread())
          .then((all) => {
            const mine = all.find((u) => u.channelId === channelId);
            if (mine) setChannelUnread(mine);
          })
          .catch((err) => failToast("未読にできませんでした", err));
      },
      toggleBookmark: (m) => {
        const on = toggleBookmarkPref(refOf(m));
        show({
          kind: "success",
          title: on ? "後で用に保存しました" : "後で用の保存を解除しました",
          ...(on ? { description: "サイドバーの「後で」から見返せます" } : {}),
        });
      },
      addReminder: (m, when) => {
        const now = new Date();
        const due = when instanceof Date ? when : reminderDueAt(when, now);
        addReminderPref(refOf(m), due);
        show({ kind: "success", title: `${formatDue(due, now)} にリマインドします`, description: "サイドバーの「後で」に表示されます" });
      },
      copyLink: (m) =>
        copyToClipboard(messagePermalink(globalThis.location, m.channelId, m.id, m.threadRootId), "リンクをコピーしました"),
      toggleFollow: (m) => {
        const on = toggleFollowPref(m.threadRootId ?? m.id);
        show(
          on
            ? { kind: "success", title: "新しい返信を通知します", description: "このチャンネルを開いている間に通知します" }
            : { kind: "success", title: "返信の通知をオフにしました" },
        );
      },
      copyText: (m) => copyToClipboard(plainText(m), "メッセージをコピーしました"),
      forward: (m) => setForwarding(m),
    };
  }, [
    api,
    bookmarks,
    follows,
    channelId,
    currentUserId,
    view,
    setChannelUnread,
    toggleBookmarkPref,
    addReminderPref,
    toggleFollowPref,
    refOf,
    plainText,
    copyToClipboard,
    failToast,
    show,
  ]);

  // Link cards (MessageUnfurl): loaded rows answer at once; others are fetched there.
  const openLink = useCallback(
    (link: MessageLink) => {
      if (link.channelId !== channelId) {
        requestMessageJump(link.messageId, link.threadRootId);
        onSelectChannel?.(link.channelId);
        return;
      }
      const rowId = link.threadRootId ?? link.messageId;
      const root = view.state.messages.find((m) => m.id === rowId);
      if (link.threadRootId && root) setThread(root);
      jumpToMessage(rowId);
    },
    [channelId, onSelectChannel, view.state.messages, jumpToMessage],
  );
  const messageLookup = useMemo<MessageLookup>(() => {
    const byId = new Map<string, Message>();
    for (const m of pinned) byId.set(m.id, m);
    for (const m of view.state.messages) byId.set(m.id, m);
    return {
      findLoaded: (id) => byId.get(id),
      resolveUser,
      resolveTeam,
      resolveChannelName: (id) => resolveChannelName?.(id),
      onOpen: openLink,
    };
  }, [pinned, view.state.messages, resolveUser, resolveTeam, resolveChannelName, openLink]);

  const onForward = useCallback(
    async (target: common.ChannelId, body: string) => {
      try {
        // Same channel: through the timeline so the row appears optimistically.
        if (target === channelId) await view.send(body);
        else await api.postMessage({ channelId: target, body, clientTempId: newClientTempId() });
      } catch (err) {
        failToast("転送できませんでした", err);
        throw err;
      }
      const name = forwardTargets.find((c) => c.id === target)?.label ?? "";
      show({ kind: "success", title: `${name} に転送しました` });
    },
    [api, channelId, view, forwardTargets, failToast, show],
  );

  // Optimistic: the modal/header reflect the patch at once; on failure only this
  // patch is reverted (version conflict included) and the reason is toasted.
  const onUpdateChannel = useCallback(
    async (patch: { name?: string; topic?: string | null; archived?: boolean }) => {
      const prev = channel;
      if (!prev) return;
      setChannel({ ...prev, ...patch });
      try {
        const updated = await api.updateChannel(channelId, { ...patch, version: prev.version });
        setChannel(updated);
        onChannelsChanged?.();
        if (patch.archived !== undefined) show({ kind: "success", title: patch.archived ? `#${prev.name} をアーカイブしました` : "アーカイブを解除しました" });
      } catch (err) {
        setChannel((cur) => (cur ? { ...cur, ...pick(prev, patch) } : cur));
        failToast("チャンネルを更新できませんでした", err);
        throw err;
      }
    },
    [api, channel, channelId, onChannelsChanged, show, failToast],
  );

  const onAddMember = useCallback(
    (user: identity.UserSummary) => {
      const temp: ChannelMember = { channelId, userId: user.id, role: "member", joinedAt: new Date().toISOString() };
      setUsers((prev) => ({ ...prev, [user.id]: user }));
      setMembers((prev) => (prev.some((m) => m.userId === user.id) ? prev : [...prev, temp]));
      api.addMember(channelId, user.id).then(
        (added) => setMembers((prev) => prev.map((m) => (m.userId === user.id ? { ...temp, ...added } : m))),
        (err) => {
          setMembers((prev) => prev.filter((m) => m.userId !== user.id));
          failToast(`${user.displayName} さんを追加できませんでした`, err);
        },
      );
    },
    [api, channelId, failToast],
  );

  const onRemoveMember = useCallback(
    (userId: common.UserId) => {
      const removed = members.find((m) => m.userId === userId);
      if (!removed) return;
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      api.removeMember(channelId, userId).catch((err) => {
        setMembers((prev) => (prev.some((m) => m.userId === userId) ? prev : [...prev, removed]));
        failToast("メンバーを削除できませんでした", err);
      });
    },
    [api, channelId, members, failToast],
  );

  const onLeave = useCallback(async () => {
    const name = channel?.name ?? "";
    try {
      await api.removeMember(channelId, currentUserId);
    } catch (err) {
      failToast("チャンネルから退出できませんでした", err);
      throw err;
    }
    setDetailsTab(null);
    show({ kind: "success", title: `#${name} から退出しました` });
    if (channel?.visibility === "private") {
      onChannelDeleted?.(channelId); // no longer readable: move off it
    } else {
      setMembership(null);
      setMembers((prev) => prev.filter((m) => m.userId !== currentUserId));
      onChannelsChanged?.();
    }
  }, [api, channel, channelId, currentUserId, show, failToast, onChannelDeleted, onChannelsChanged]);

  const onDeleteChannel = useCallback(async () => {
    const name = channel?.name ?? "";
    try {
      await api.deleteChannel(channelId);
    } catch (err) {
      failToast("チャンネルを削除できませんでした", err);
      throw err;
    }
    setDetailsTab(null);
    show({ kind: "success", title: `#${name} を削除しました` });
    onChannelDeleted?.(channelId);
  }, [api, channel, channelId, show, failToast, onChannelDeleted]);

  const archived = channel?.archived ?? false;
  // A DM shows "the other side" (resolved from its members), not its stored name.
  const shownChannel = useMemo(
    () => (channel ? { ...channel, name: channelLabel(channel, currentUserId, (id) => users[id]) ?? channel.name } : null),
    [channel, currentUserId, users],
  );
  const searchOpen = searchQuery.trim().length >= 2;

  return (
    <MessageActionsContext.Provider value={messageActions}>
      <MessageLookupContext.Provider value={messageLookup}>
      <section className={styles.main}>
        {shownChannel && (
          <ChannelHeader
            channel={shownChannel}
            canModerate={canModerate}
            canOpenSettings={shownChannel.type !== "dm"}
            members={members}
            pinned={pinned}
            searchValue={searchQuery}
            resolveUser={resolveUser}
            resolveTeam={resolveTeam}
            onOpenSettings={() => setDetailsTab("about")}
            onSearchChange={setSearchQuery}
            onUnpin={onUnpin}
            onJumpToMessage={jumpToMessage}
            onOpenMobileNav={onOpenMobileNav}
          />
        )}
        {searchOpen && (
          <SearchResults
            query={searchQuery.trim()}
            loading={searchLoading}
            results={searchResults}
            resolveUser={resolveUser}
            resolveTeam={resolveTeam}
            onSelect={onSelectSearchHit}
            onClose={() => {
              setSearchQuery("");
              setSearchResults([]);
            }}
          />
        )}
        <ConnectionBanner status={view.state.rtStatus} />
        {archived && <ConnectionBanner status={view.state.rtStatus} archived />}
        <MessageTimeline
          messages={view.state.messages}
          pending={view.state.pending}
          currentUserId={currentUserId}
          canModerate={canModerate}
          lastReadMessageId={view.state.lastReadMessageId}
          hasOlder={view.state.nextCursor !== null}
          pinnedIds={pinnedIds}
          resolveUser={resolveUser}
          resolveTeam={resolveTeam}
          myTeamIds={myTeamIds}
          onLoadOlder={() => void view.loadOlder()}
          onToggleReaction={(id, emoji) => void view.toggleReaction(id, emoji)}
          onSubmitEdit={onSubmitEdit}
          onDelete={onDelete}
          onReply={(m) => setThread(m)}
          onOpenThread={(m) => setThread(m)}
          onTogglePin={onTogglePin}
          onResend={(id) => void view.resend(id)}
          onDiscard={(id) => view.discard(id)}
        />
        <MessageComposer
          channelId={channelId}
          disabled={archived}
          disabledReason="アーカイブ済みチャネルには投稿できません"
          placeholder={shownChannel ? `${channelHandle(shownChannel, shownChannel.name)} へメッセージ` : "メッセージを入力"}
          error={composerError}
          resolveMentionCandidates={resolveMentionCandidates}
          resolveUser={resolveUser}
          resolveTeam={resolveTeam}
          onSend={onSend}
        />
      </section>

      {thread &&
        (() => {
          const pane = (
            <ThreadPane
              channelId={channelId}
              root={thread}
              currentUserId={currentUserId}
              canModerate={canModerate}
              resolveUser={resolveUser}
              resolveTeam={resolveTeam}
              resolveMentionCandidates={resolveMentionCandidates}
              onToggleReaction={(id, emoji) => void view.toggleReaction(id, emoji)}
              onClose={() => setThread(null)}
            />
          );
          // Mobile (P21): the thread pane is a 4th grid column on desktop, which
          // has no room on a phone screen — slide it in as a right-side drawer
          // instead. ThreadPane keeps its own header/close button either way, so
          // the Drawer chrome is hidden (hideHeader) to avoid a duplicate one.
          return isMobile ? (
            <Drawer open onClose={() => setThread(null)} side="right" hideHeader title="スレッド" testId="fe6-mobile-thread-drawer">
              {pane}
            </Drawer>
          ) : (
            pane
          );
        })()}

      {channel && detailsTab && channel.type !== "dm" && (
        <ChannelDetails
          open
          onClose={() => setDetailsTab(null)}
          channel={channel}
          currentUserId={currentUserId}
          members={members}
          membersLoaded={membersLoaded}
          resolveUser={resolveUser}
          canEdit={canModerate}
          initialTab={detailsTab}
          onUpdate={onUpdateChannel}
          searchUsers={searchUsers}
          onAddMember={onAddMember}
          onRemoveMember={onRemoveMember}
          {...(membership ? { onLeave } : {})}
          {...(canDelete ? { onDelete: onDeleteChannel } : {})}
          {...(sections ? { sections } : {})}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="メッセージを削除しますか？"
        message="このメッセージを削除します。この操作は取り消せません。"
        confirmLabel="削除する"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
        testId="fe6-timeline-delete-confirm"
      />

      {forwarding && (
        <ForwardMessageModal
          sourceChannelName={shownChannel ? channelHandle(shownChannel, shownChannel.name) : ""}
          channels={forwardTargets}
          authorName={forwarding.authorId === null ? "システム" : (users[forwarding.authorId]?.displayName ?? forwarding.authorId)}
          preview={plainText(forwarding)}
          hasAttachments={forwarding.attachments.length > 0}
          onClose={() => setForwarding(null)}
          link={messagePermalink(globalThis.location, forwarding.channelId, forwarding.id, forwarding.threadRootId)}
          onForward={onForward}
        />
      )}
      </MessageLookupContext.Provider>
    </MessageActionsContext.Provider>
  );
}

// The fields of `prev` that `patch` touched — reverts one optimistic patch only.
function pick(prev: Channel, patch: Partial<Channel>): Partial<Channel> {
  const out: Partial<Channel> = {};
  for (const k of Object.keys(patch) as (keyof Channel)[]) (out as Record<string, unknown>)[k] = prev[k];
  return out;
}
