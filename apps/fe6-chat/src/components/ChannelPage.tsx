/// <reference lib="dom" />
// Container: wires channel detail + timeline + composer + connection/archived
// banner + read tracking for one channel, plus the right-hand thread pane, the
// members/pins popovers, workspace search, message edit, attachments, and the
// channel-settings modal. The main section and the ThreadPane are returned as
// sibling fragment children so both land as columns of the ChatApp grid.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, Modal, useToast } from "@dub/ui";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import { useChannelView } from "../hooks/useChannelView";
import { ReadTracker } from "../store/read-tracker";
import { mapChatError } from "../lib/errors";
import { ChatApiError } from "../api/client";
import type { Attachment, Channel, ChannelMember, Message, SearchHit } from "../api/contract";
import { ChannelHeader } from "./ChannelHeader";
import { ChannelSettingsForm } from "./ChannelSettingsForm";
import { MessageTimeline } from "./MessageTimeline";
import { MessageComposer } from "./MessageComposer";
import { ConnectionBanner } from "./ConnectionBanner";
import { SearchResults } from "./SearchResults";
import { ThreadPane } from "./ThreadPane";
import styles from "../styles/chat.module.css";

export function ChannelPage({
  channelId,
  onThreadOpenChange,
  onSelectChannel,
  onChannelsChanged,
}: {
  channelId: common.ChannelId;
  onThreadOpenChange?: (open: boolean) => void;
  onSelectChannel?: (channelId: common.ChannelId) => void;
  onChannelsChanged?: () => void;
}) {
  const { api, can, currentUserId } = useChatRuntime();
  const view = useChannelView(channelId);
  const { show } = useToast();
  const markRead = useChatStore((s) => s.markRead);

  const [channel, setChannel] = useState<Channel | null>(null);
  const [membership, setMembership] = useState<ChannelMember | null>(null);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [users, setUsers] = useState<Record<common.UserId, identity.UserSummary>>({});
  const [composerError, setComposerError] = useState<string | null>(null);
  const [thread, setThread] = useState<Message | null>(null);
  const [pinned, setPinned] = useState<Message[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);

  // search state (workspace-wide)
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const canModerate = can("chat:moderate") || membership?.role === "admin";
  const pinnedIds = useMemo(() => new Set(pinned.map((m) => m.id)), [pinned]);

  useEffect(() => {
    setThread(null);
    setSearchQuery("");
    setSearchResults([]);
  }, [channelId]);

  useEffect(() => {
    onThreadOpenChange?.(thread !== null);
  }, [thread, onThreadOpenChange]);

  // channel detail + members + pins
  useEffect(() => {
    let cancelled = false;
    void api.getChannel(channelId).then((res) => {
      if (cancelled) return;
      setChannel(res.channel);
      setMembership(res.membership);
    });
    void api.listMembers(channelId).then((m) => !cancelled && setMembers(m));
    void api.listPinned(channelId).then((p) => !cancelled && setPinned(p));
    return () => {
      cancelled = true;
    };
  }, [api, channelId]);

  // resolve author display names in batch as new authors/members appear
  useEffect(() => {
    // Drop null authorIds (system posts have no author to resolve).
    const authorIds = view.state.messages.map((m) => m.authorId).filter((id): id is common.UserId => id !== null);
    const ids = new Set<common.UserId>([...authorIds, ...members.map((m) => m.userId)]);
    const missing = [...ids].filter((id) => !(id in users));
    if (missing.length === 0) return;
    let cancelled = false;
    void api.resolveUsers(missing).then((summaries) => {
      if (cancelled) return;
      setUsers((prev) => {
        const next = { ...prev };
        for (const u of summaries) next[u.id] = u;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, view.state.messages, members, users]);

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
  useEffect(() => {
    if (newestId) tracker.current?.observeBottom(newestId);
  }, [newestId]);

  const resolveUser = useCallback((id: common.UserId) => users[id], [users]);
  const resolveMentionCandidates = useCallback(
    (query: string): identity.UserSummary[] => {
      const q = query.toLowerCase();
      return Object.values(users)
        .filter((u) => u.displayName.toLowerCase().includes(q))
        .slice(0, 8);
    },
    [users],
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

  const onSaveSettings = useCallback(
    async (patch: { name: string; topic: string | null; version: number }) => {
      const updated = await api.updateChannel(channelId, patch);
      setChannel(updated);
      setSettingsOpen(false);
      onChannelsChanged?.();
    },
    [api, channelId, onChannelsChanged],
  );

  const onArchiveToggle = useCallback(
    async (archived: boolean, version: number) => {
      const updated = await api.updateChannel(channelId, { archived, version });
      setChannel(updated);
      setSettingsOpen(false);
      onChannelsChanged?.();
    },
    [api, channelId, onChannelsChanged],
  );

  const archived = channel?.archived ?? false;
  const searchOpen = searchQuery.trim().length >= 2;

  return (
    <>
      <section className={styles.main}>
        {channel && (
          <ChannelHeader
            channel={channel}
            canModerate={canModerate}
            members={members}
            pinned={pinned}
            searchValue={searchQuery}
            resolveUser={resolveUser}
            onOpenSettings={() => setSettingsOpen(true)}
            onSearchChange={setSearchQuery}
            onUnpin={onUnpin}
            onJumpToMessage={jumpToMessage}
          />
        )}
        {searchOpen && (
          <SearchResults
            query={searchQuery.trim()}
            loading={searchLoading}
            results={searchResults}
            resolveUser={resolveUser}
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
          placeholder={channel ? `#${channel.name} へメッセージ` : "メッセージを入力"}
          error={composerError}
          resolveMentionCandidates={resolveMentionCandidates}
          onSend={onSend}
        />
      </section>

      {thread && (
        <ThreadPane
          channelId={channelId}
          root={thread}
          currentUserId={currentUserId}
          canModerate={canModerate}
          resolveUser={resolveUser}
          resolveMentionCandidates={resolveMentionCandidates}
          onToggleReaction={(id, emoji) => void view.toggleReaction(id, emoji)}
          onClose={() => setThread(null)}
        />
      )}

      {channel && settingsOpen && (
        <Modal open onClose={() => setSettingsOpen(false)} title={`#${channel.name} の設定`} size="sm">
          <ChannelSettingsForm channel={channel} onSave={onSaveSettings} onArchiveToggle={onArchiveToggle} />
        </Modal>
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
    </>
  );
}
