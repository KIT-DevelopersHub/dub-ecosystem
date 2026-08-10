// Single message row (Slack-style density). Renders:
//  - avatar gutter (full row) or hover-only timestamp (grouped consecutive post)
//  - Md-subset body: text / mentions / inline code / fenced code blocks
//  - reaction pills (+ add) and a thread reply summary (faces + "N replies")
//  - a hover action bar (react / reply / edit / delete)
// Edit/delete are gated by authorship + can("chat:moderate") (design §6).
// Deleted messages render as a redacted tombstone. Test-ids preserved for units.
import { Avatar } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Message } from "../api/contract";
import { segmentBody } from "../lib/render-body";
import styles from "../styles/chat.module.css";

export interface MessageItemProps {
  message: Message;
  currentUserId: common.UserId;
  canModerate: boolean;
  grouped?: boolean; // same author + short gap as the previous row → compact
  mentionsMe?: boolean; // highlight the whole row (yellow rail)
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onEdit?: (message: Message) => void;
  onDelete?: (message: Message) => void; // opens ConfirmDialog upstream
  onReply?: (message: Message) => void; // open/append in the thread pane
  onOpenThread?: (message: Message) => void;
}

function nameOf(id: common.UserId, resolve?: MessageItemProps["resolveUser"]): string {
  return resolve?.(id)?.displayName ?? id;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

function timeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

const QUICK_REACTIONS = ["👍", "🎉", "👀", "✅"];

export function MessageItem({
  message,
  currentUserId,
  canModerate,
  grouped = false,
  mentionsMe = false,
  resolveUser,
  onToggleReaction,
  onEdit,
  onDelete,
  onReply,
  onOpenThread,
}: MessageItemProps) {
  const isAuthor = message.authorId === currentUserId;
  const isDeleted = message.deletedAt !== null;
  const canEdit = isAuthor && !isDeleted; // authors only — even moderators can't edit others'
  const canDelete = (isAuthor || canModerate) && !isDeleted;
  const authorName = nameOf(message.authorId, resolveUser);
  const authorAvatar = resolveUser?.(message.authorId)?.avatarUrl ?? undefined;

  const rowClasses = [styles.messageRow, grouped ? styles.grouped : "", mentionsMe ? styles.mentionsMe : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClasses} data-testid="fe6-timeline-message" data-message-id={message.id}>
      {/* hover action bar */}
      {!isDeleted && (
        <div className={styles.hoverActions} role="toolbar" aria-label="メッセージ操作">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              className={styles.hoverAction}
              aria-label={`${e} を追加`}
              onClick={() => onToggleReaction?.(message.id, e)}
            >
              {e}
            </button>
          ))}
          <button type="button" className={styles.hoverAction} aria-label="スレッドで返信" onClick={() => onReply?.(message)}>
            💬
          </button>
          {canEdit && (
            <button
              type="button"
              className={styles.hoverAction}
              aria-label="編集"
              data-testid="fe6-timeline-edit"
              onClick={() => onEdit?.(message)}
            >
              ✏️
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className={styles.hoverAction}
              aria-label="削除"
              data-testid="fe6-timeline-delete"
              onClick={() => onDelete?.(message)}
            >
              🗑
            </button>
          )}
        </div>
      )}

      <div className={styles.avatarCol}>
        {grouped ? (
          <span className={styles.gutterTime} aria-hidden>
            {timeShort(message.createdAt)}
          </span>
        ) : (
          <Avatar name={authorName} src={authorAvatar} size="md" />
        )}
      </div>

      <div className={styles.msgBody}>
        {!grouped && (
          <div className={styles.msgHeader}>
            <span className={styles.author}>{authorName}</span>
            <span className={styles.time}>{timeShort(message.createdAt)}</span>
            {message.editedAt && <span className={styles.editedTag}>(編集済み)</span>}
          </div>
        )}

        {isDeleted ? (
          <div className={styles.deleted} data-testid="fe6-timeline-deleted">
            このメッセージは削除されました
          </div>
        ) : (
          <div className={styles.textBody} data-testid="fe6-timeline-body">
            {segmentBody(message.body).map((seg, i) => {
              if (seg.type === "mention") {
                return (
                  <span key={i} className={styles.mention}>
                    @{nameOf(seg.userId, resolveUser)}
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
              if (seg.type === "codeblock") {
                return (
                  <pre key={i} className={styles.codeBlock}>
                    <code>{seg.value}</code>
                  </pre>
                );
              }
              return <span key={i}>{seg.value}</span>;
            })}
            {grouped && message.editedAt && <span className={styles.editedTag}> (編集済み)</span>}
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
                  <span className={styles.reactionCount}>{r.userIds.length}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={styles.addReaction}
              aria-label="リアクションを追加"
              onClick={() => onToggleReaction?.(message.id, "👍")}
            >
              😊＋
            </button>
          </div>
        )}

        {!isDeleted && message.replyCount > 0 && (
          <button type="button" className={styles.threadSummary} onClick={() => onOpenThread?.(message)}>
            <span className={styles.threadFaces} aria-hidden>
              <span className={styles.threadFace} style={{ background: "#4a154b" }}>
                {initials(authorName)}
              </span>
            </span>
            <span className={styles.threadCount}>{message.replyCount} 件の返信</span>
            <span className={styles.threadLast}>スレッドを表示</span>
          </button>
        )}
      </div>
    </div>
  );
}
