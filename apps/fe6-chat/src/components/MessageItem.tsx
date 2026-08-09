// Single message row: Md-subset body, mentions, reactions, and an edit/delete
// menu gated by authorship + can("chat:moderate") (design §6). Deleted messages
// render as a redacted tombstone.
import type { common, identity } from "@dub/types";
import type { Message } from "../api/contract";
import { segmentBody } from "../lib/render-body";
import styles from "../styles/chat.module.css";

export interface MessageItemProps {
  message: Message;
  currentUserId: common.UserId;
  canModerate: boolean;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onEdit?: (message: Message) => void;
  onDelete?: (message: Message) => void; // opens ConfirmDialog upstream
}

function displayName(id: common.UserId, resolve?: MessageItemProps["resolveUser"]): string {
  return resolve?.(id)?.displayName ?? id;
}

export function MessageItem({
  message,
  currentUserId,
  canModerate,
  resolveUser,
  onToggleReaction,
  onEdit,
  onDelete,
}: MessageItemProps) {
  const isAuthor = message.authorId === currentUserId;
  const isDeleted = message.deletedAt !== null;
  const canEdit = isAuthor && !isDeleted; // authors only, even moderators can't edit others'
  const canDelete = (isAuthor || canModerate) && !isDeleted;

  return (
    <div className={styles.message} data-testid="fe6-timeline-message" data-message-id={message.id}>
      <div className={styles.messageMeta}>
        <span className={styles.author}>{displayName(message.authorId, resolveUser)}</span>
        <span className={styles.time}>{new Date(message.createdAt).toLocaleTimeString("ja-JP")}</span>
        {message.editedAt && <span className={styles.time}>(編集済み)</span>}
      </div>

      {isDeleted ? (
        <div className={styles.deleted} data-testid="fe6-timeline-deleted">
          このメッセージは削除されました
        </div>
      ) : (
        <div data-testid="fe6-timeline-body">
          {segmentBody(message.body).map((seg, i) => {
            if (seg.type === "mention") {
              return (
                <span key={i} className={styles.mention}>
                  @{displayName(seg.userId, resolveUser)}
                </span>
              );
            }
            if (seg.type === "code") {
              return (
                <code key={i} className={styles.inlineCode}>
                  {seg.value}
                </code>
              );
            }
            return <span key={i}>{seg.value}</span>;
          })}
        </div>
      )}

      {!isDeleted && message.reactions.length > 0 && (
        <div className={styles.reactionBar}>
          {message.reactions.map((r) => {
            const mine = r.userIds.includes(currentUserId);
            return (
              <button
                key={r.emoji}
                type="button"
                className={`${styles.reaction} ${mine ? styles.mine : ""}`}
                data-testid="fe6-timeline-reaction"
                onClick={() => onToggleReaction?.(message.id, r.emoji)}
              >
                <span>{r.emoji}</span>
                <span>{r.userIds.length}</span>
              </button>
            );
          })}
        </div>
      )}

      {(canEdit || canDelete) && (
        <div>
          {canEdit && (
            <button type="button" data-testid="fe6-timeline-edit" onClick={() => onEdit?.(message)}>
              編集
            </button>
          )}
          {canDelete && (
            <button type="button" data-testid="fe6-timeline-delete" onClick={() => onDelete?.(message)}>
              削除
            </button>
          )}
        </div>
      )}
    </div>
  );
}
