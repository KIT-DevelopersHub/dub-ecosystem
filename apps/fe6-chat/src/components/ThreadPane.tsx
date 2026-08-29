/// <reference lib="dom" />
// Right-hand thread pane: the root message + its replies + a thread-scoped
// composer. Replies are fetched with listMessages({ threadRootId }) and posted
// with postMessage({ threadRootId }); kept local to the pane so opening a thread
// never disturbs the main timeline. Non-optimistic here (design keeps the main
// timeline as the optimistic surface) — a reply appears once the server acks.
import { useCallback, useEffect, useState } from "react";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import type { Message } from "../api/contract";
import { newClientTempId } from "../lib/ulid";
import { MessageItem } from "./MessageItem";
import { MessageComposer } from "./MessageComposer";
import { Icon } from "@dub/ui";
import styles from "../styles/chat.module.css";

export interface ThreadPaneProps {
  channelId: common.ChannelId;
  root: Message;
  currentUserId: common.UserId;
  canModerate: boolean;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  resolveMentionCandidates?: (query: string) => identity.UserSummary[];
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onClose: () => void;
}

export function ThreadPane({
  channelId,
  root,
  currentUserId,
  canModerate,
  resolveUser,
  resolveMentionCandidates,
  onToggleReaction,
  onClose,
}: ThreadPaneProps) {
  const { api } = useChatRuntime();
  const [replies, setReplies] = useState<Message[]>([]);
  const [localUsers, setLocalUsers] = useState<Record<common.UserId, identity.UserSummary>>({});

  useEffect(() => {
    let cancelled = false;
    void api.listMessages({ channelId, threadRootId: root.id }).then((page) => {
      if (!cancelled) setReplies(page.items.slice().sort((a, b) => (a.id < b.id ? -1 : 1)));
    });
    return () => {
      cancelled = true;
    };
  }, [api, channelId, root.id]);

  // resolve reply authors the parent timeline may not have seen yet
  useEffect(() => {
    const ids = Array.from(new Set([root.authorId, ...replies.map((m) => m.authorId)]));
    const missing = ids.filter((id) => !resolveUser?.(id) && !(id in localUsers));
    if (missing.length === 0) return;
    let cancelled = false;
    void api.resolveUsers(missing).then((summaries) => {
      if (cancelled) return;
      setLocalUsers((prev) => {
        const next = { ...prev };
        for (const u of summaries) next[u.id] = u;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, replies, root.authorId, resolveUser, localUsers]);

  const resolve = (id: common.UserId): identity.UserSummary | undefined => resolveUser?.(id) ?? localUsers[id];

  const onSend = useCallback(
    async (body: string) => {
      const res = await api.postMessage({ channelId, body, threadRootId: root.id, clientTempId: newClientTempId() });
      setReplies((prev) => [...prev, res.message]);
    },
    [api, channelId, root.id],
  );

  return (
    <aside className={styles.thread} aria-label="スレッド" data-testid="fe6-thread-pane">
      <header className={styles.threadHeader}>
        <div>
          <div className={styles.threadTitle}>スレッド</div>
          <div className={styles.threadSub}>{replies.length} 件の返信</div>
        </div>
        <button type="button" className={styles.iconBtn} aria-label="スレッドを閉じる" onClick={onClose}>
          <Icon name="x" size="sm" />
        </button>
      </header>

      <div className={styles.threadBody}>
        <MessageItem
          message={root}
          currentUserId={currentUserId}
          canModerate={canModerate}
          resolveUser={resolve}
          onToggleReaction={onToggleReaction}
        />
        <div className={styles.threadReplyCount}>{replies.length} 件の返信</div>
        {replies.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            currentUserId={currentUserId}
            canModerate={canModerate}
            resolveUser={resolve}
            onToggleReaction={onToggleReaction}
          />
        ))}
      </div>

      <MessageComposer
        channelId={`${channelId}:thread:${root.id}` as common.ChannelId}
        placeholder="スレッドに返信する"
        resolveMentionCandidates={resolveMentionCandidates}
        onSend={onSend}
      />
    </aside>
  );
}
