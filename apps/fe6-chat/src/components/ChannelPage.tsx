/// <reference lib="dom" />
// Container: wires channel detail + timeline + composer + connection/archived
// banner + read tracking for one channel, plus the right-hand thread pane.
// Delete is confirmed (window.confirm as the ConfirmDialog stand-in). The main
// section and the ThreadPane are returned as sibling fragment children so both
// land as columns of the ChatApp grid.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import { useChatStore } from "../store/useChatStore";
import { useChannelView } from "../hooks/useChannelView";
import { ReadTracker } from "../store/read-tracker";
import { mapChatError } from "../lib/errors";
import { ChatApiError } from "../api/client";
import type { Channel, ChannelMember, Message } from "../api/contract";
import { ChannelHeader } from "./ChannelHeader";
import { MessageTimeline } from "./MessageTimeline";
import { MessageComposer } from "./MessageComposer";
import { ConnectionBanner } from "./ConnectionBanner";
import { ThreadPane } from "./ThreadPane";
import styles from "../styles/chat.module.css";

export function ChannelPage({
  channelId,
  onThreadOpenChange,
}: {
  channelId: common.ChannelId;
  onThreadOpenChange?: (open: boolean) => void;
}) {
  const { api, can, currentUserId } = useChatRuntime();
  const view = useChannelView(channelId);
  const markRead = useChatStore((s) => s.markRead);

  const [channel, setChannel] = useState<Channel | null>(null);
  const [membership, setMembership] = useState<ChannelMember | null>(null);
  const [users, setUsers] = useState<Record<common.UserId, identity.UserSummary>>({});
  const [composerError, setComposerError] = useState<string | null>(null);
  const [thread, setThread] = useState<Message | null>(null);

  const canModerate = can("chat:moderate") || membership?.role === "admin";

  useEffect(() => {
    setThread(null);
  }, [channelId]);

  useEffect(() => {
    onThreadOpenChange?.(thread !== null);
  }, [thread, onThreadOpenChange]);

  // channel detail
  useEffect(() => {
    let cancelled = false;
    void api.getChannel(channelId).then((res) => {
      if (cancelled) return;
      setChannel(res.channel);
      setMembership(res.membership);
    });
    return () => {
      cancelled = true;
    };
  }, [api, channelId]);

  // resolve author display names in batch as new authors appear
  useEffect(() => {
    const authorIds = Array.from(new Set(view.state.messages.map((m) => m.authorId)));
    const missing = authorIds.filter((id) => !(id in users));
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
  }, [api, view.state.messages, users]);

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
    async (body: string) => {
      setComposerError(null);
      try {
        await view.send(body);
      } catch (err) {
        const code = err instanceof ChatApiError ? err.code : "INTERNAL";
        setComposerError(mapChatError(code).message);
      }
    },
    [view],
  );

  const onDelete = useCallback(
    (message: Message) => {
      if (globalThis.confirm?.("このメッセージを削除しますか？")) {
        void view.deleteMessage(message.id, message.version);
      }
    },
    [view],
  );

  const archived = channel?.archived ?? false;
  const bannerArchived = useMemo(() => archived, [archived]);

  return (
    <>
      <section className={styles.main}>
        {channel && <ChannelHeader channel={channel} canModerate={canModerate} />}
        <ConnectionBanner status={view.state.rtStatus} />
        {bannerArchived && <ConnectionBanner status={view.state.rtStatus} archived />}
        <MessageTimeline
          messages={view.state.messages}
          pending={view.state.pending}
          currentUserId={currentUserId}
          canModerate={canModerate}
          lastReadMessageId={view.state.lastReadMessageId}
          hasOlder={view.state.nextCursor !== null}
          resolveUser={resolveUser}
          onLoadOlder={() => void view.loadOlder()}
          onToggleReaction={(id, emoji) => void view.toggleReaction(id, emoji)}
          onDelete={onDelete}
          onReply={(m) => setThread(m)}
          onOpenThread={(m) => setThread(m)}
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
    </>
  );
}
