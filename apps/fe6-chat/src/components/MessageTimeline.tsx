// Timeline: day dividers, unread divider, grouped messages, and optimistic
// pending rows. Consecutive posts by the same author within a short window are
// "grouped" (avatar/name hidden, hover timestamp) for Slack-style density.
// Native scroll + loadOlder paging (FE6 virtualization deferred, design §8-1 #7).
import { Avatar } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Message } from "../api/contract";
import type { PendingMessage } from "../types";
import { firstUnreadIndex, needsDateDivider } from "../lib/timeline-view";
import { isMentioned } from "../lib/mentions";
import { MessageItem } from "./MessageItem";
import styles from "../styles/chat.module.css";

export interface MessageTimelineProps {
  messages: Message[];
  pending: PendingMessage[];
  currentUserId: common.UserId;
  canModerate: boolean;
  lastReadMessageId: common.MessageId | null;
  hasOlder: boolean;
  pinnedIds?: ReadonlySet<common.MessageId>;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onLoadOlder?: () => void;
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onSubmitEdit?: (message: Message, body: string) => void | Promise<void>;
  onDelete?: (message: Message) => void;
  onReply?: (message: Message) => void;
  onOpenThread?: (message: Message) => void;
  onTogglePin?: (message: Message) => void;
  onResend?: (clientTempId: string) => void;
  onDiscard?: (clientTempId: string) => void;
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

/** Same author as the previous row, same day, and within the group window. */
function isGrouped(messages: Message[], i: number): boolean {
  if (i === 0) return false;
  if (needsDateDivider(messages, i)) return false;
  const prev = messages[i - 1];
  const cur = messages[i];
  if (!prev || !cur) return false;
  if (prev.authorId !== cur.authorId) return false;
  if (prev.deletedAt || cur.deletedAt) return false;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
}

export function MessageTimeline(props: MessageTimelineProps) {
  const { messages, pending, currentUserId, lastReadMessageId } = props;
  const unreadAt = firstUnreadIndex(messages, lastReadMessageId, currentUserId);

  return (
    <div className={styles.timeline} data-testid="fe6-channel-timeline">
      {props.hasOlder && (
        <button type="button" className={styles.loadOlder} onClick={props.onLoadOlder} data-testid="fe6-timeline-load-older">
          以前のメッセージを読み込む
        </button>
      )}

      {messages.map((m, i) => {
        const grouped = isGrouped(messages, i) && i !== unreadAt;
        const mentionsMe = m.authorId !== currentUserId && isMentioned(m.body, currentUserId);
        return (
          <div key={m.id}>
            {needsDateDivider(messages, i) && (
              <div className={styles.dateDivider}>
                <span className={styles.dateDividerLabel}>{dateLabel(m.createdAt)}</span>
              </div>
            )}
            {i === unreadAt && (
              <div className={styles.unreadDivider} data-testid="fe6-timeline-unread-divider">
                新着メッセージ
              </div>
            )}
            <MessageItem
              message={m}
              currentUserId={currentUserId}
              canModerate={props.canModerate}
              grouped={grouped}
              mentionsMe={mentionsMe}
              pinned={props.pinnedIds?.has(m.id) ?? false}
              resolveUser={props.resolveUser}
              onToggleReaction={props.onToggleReaction}
              onSubmitEdit={props.onSubmitEdit}
              onDelete={props.onDelete}
              onReply={props.onReply}
              onOpenThread={props.onOpenThread}
              onTogglePin={props.onTogglePin}
            />
          </div>
        );
      })}

      {pending.map((p) => (
        <div
          key={p.clientTempId}
          className={`${styles.messageRow} ${p.state === "failed" ? styles.failed : styles.pending}`}
          data-testid="fe6-timeline-pending"
          data-pending-state={p.state}
        >
          <div className={styles.avatarCol}>
            <Avatar name={props.resolveUser?.(p.authorId)?.displayName ?? "…"} size="md" />
          </div>
          <div className={styles.msgBody}>
            <div className={styles.textBody} data-testid="fe6-timeline-body">
              {p.request.body}
            </div>
            {p.state === "failed" && (
              <div className={styles.failedNote}>
                <span>送信に失敗しました</span>
                <button type="button" className={styles.linkBtn} data-testid="fe6-pending-resend" onClick={() => props.onResend?.(p.clientTempId)}>
                  再送
                </button>
                <button type="button" className={styles.linkBtn} data-testid="fe6-pending-discard" onClick={() => props.onDiscard?.(p.clientTempId)}>
                  破棄
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
