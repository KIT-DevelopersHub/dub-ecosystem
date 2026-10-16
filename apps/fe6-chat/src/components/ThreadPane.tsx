/// <reference lib="dom" />
// Right-hand thread pane: the root message + its replies + a thread-scoped
// composer. Replies are fetched with listMessages({ threadRootId }) and posted
// with postMessage({ threadRootId }); kept local to the pane so opening a thread
// never disturbs the main timeline. Non-optimistic here (design keeps the main
// timeline as the optimistic surface) — a reply appears once the server acks.
import { useCallback, useEffect, useRef, useState } from "react";
import type { common, identity } from "@dub/types";
import { useChatRuntime } from "../context";
import type { Message, TeamSummary } from "../api/contract";
import { IDENTITY_BATCH_MAX } from "../api/client";
import { extractMentions, type MentionCandidate } from "../lib/mentions";
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
  resolveTeam?: (id: string) => TeamSummary | undefined;
  resolveMentionCandidates?: (query: string) => MentionCandidate[];
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onClose: () => void;
}

export function ThreadPane({
  channelId,
  root,
  currentUserId,
  canModerate,
  resolveUser,
  resolveTeam,
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

  // resolve reply authors / @-mentioned users the parent timeline may not have seen yet
  const unresolvable = useRef(new Set<common.UserId>());
  useEffect(() => {
    // Drop null authorIds (system posts have no author to resolve).
    const thread = [root, ...replies];
    const ids = Array.from(
      new Set([...thread.map((m) => m.authorId), ...thread.flatMap((m) => extractMentions(m.body))]),
    ).filter((id): id is common.UserId => id !== null);
    const missing = ids.filter((id) => !resolveUser?.(id) && !(id in localUsers) && !unresolvable.current.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void api.resolveUsers(missing).then((summaries) => {
      if (cancelled) return;
      const found = new Set(summaries.map((u) => u.id));
      for (const id of missing.slice(0, IDENTITY_BATCH_MAX)) if (!found.has(id)) unresolvable.current.add(id);
      setLocalUsers((prev) => {
        const next = { ...prev };
        for (const u of summaries) next[u.id] = u;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, replies, root, resolveUser, localUsers]);

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
          resolveTeam={resolveTeam}
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
            resolveTeam={resolveTeam}
            onToggleReaction={onToggleReaction}
          />
        ))}
      </div>

      <MessageComposer
        channelId={`${channelId}:thread:${root.id}` as common.ChannelId}
        placeholder="スレッドに返信する"
        resolveMentionCandidates={resolveMentionCandidates}
        resolveUser={resolveUser}
        resolveTeam={resolveTeam}
        onSend={onSend}
      />
    </aside>
  );
}
