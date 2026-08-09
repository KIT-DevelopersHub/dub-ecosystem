// Timeline: day dividers, unread divider, messages, and optimistic pending rows.
// FE6-internal virtualization is deferred (design §8-1 #7 — kept simple here; the
// list scrolls natively and loadOlder pages history). "New message jump" surfaces
// when the user is scrolled up.
import type { common, identity } from "@dub/types";
import type { Message } from "../api/contract";
import type { PendingMessage } from "../types";
import { firstUnreadIndex, needsDateDivider } from "../lib/timeline-view";
import { MessageItem } from "./MessageItem";
import styles from "../styles/chat.module.css";

export interface MessageTimelineProps {
  messages: Message[];
  pending: PendingMessage[];
  currentUserId: common.UserId;
  canModerate: boolean;
  lastReadMessageId: common.MessageId | null;
  hasOlder: boolean;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onLoadOlder?: () => void;
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onEdit?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onResend?: (clientTempId: string) => void;
  onDiscard?: (clientTempId: string) => void;
}

export function MessageTimeline(props: MessageTimelineProps) {
  const { messages, pending, currentUserId, lastReadMessageId } = props;
  const unreadAt = firstUnreadIndex(messages, lastReadMessageId, currentUserId);

  return (
    <div className={styles.timeline} data-testid="fe6-channel-timeline">
      {props.hasOlder && (
        <button type="button" onClick={props.onLoadOlder} data-testid="fe6-timeline-load-older">
          以前のメッセージを読み込む
        </button>
      )}

      {messages.map((m, i) => (
        <div key={m.id}>
          {needsDateDivider(messages, i) && (
            <div className={styles.dateDivider}>{m.createdAt.slice(0, 10)}</div>
          )}
          {i === unreadAt && (
            <div className={styles.unreadDivider} data-testid="fe6-timeline-unread-divider">
              ここから未読
            </div>
          )}
          <MessageItem
            message={m}
            currentUserId={currentUserId}
            canModerate={props.canModerate}
            resolveUser={props.resolveUser}
            onToggleReaction={props.onToggleReaction}
            onEdit={props.onEdit}
            onDelete={props.onDelete}
          />
        </div>
      ))}

      {pending.map((p) => (
        <div
          key={p.clientTempId}
          className={`${styles.message} ${p.state === "failed" ? styles.failed : styles.pending}`}
          data-testid="fe6-timeline-pending"
          data-pending-state={p.state}
        >
          <div data-testid="fe6-timeline-body">{p.request.body}</div>
          {p.state === "failed" && (
            <div>
              <span className={styles.deleted}>送信に失敗しました</span>
              <button type="button" data-testid="fe6-pending-resend" onClick={() => props.onResend?.(p.clientTempId)}>
                再送
              </button>
              <button type="button" data-testid="fe6-pending-discard" onClick={() => props.onDiscard?.(p.clientTempId)}>
                破棄
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
