/// <reference lib="dom" />
// Single message row (Slack-style density). Renders:
//  - avatar gutter (full row) or hover-only timestamp (grouped consecutive post)
//  - Md-subset body: text / bold / italic / strike / link / mention / inline
//    code / fenced code blocks
//  - attachments (images inline, files as chips)
//  - reaction pills (+ emoji picker) and a thread reply summary (faces + "N replies")
//  - a hover action bar (react / reply / edit / delete / pin)
//  - inline edit editor (author-only), Enter saves · Esc cancels
// Edit/delete are gated by authorship + can("chat:moderate") (design §6).
// Deleted messages render as a redacted tombstone. Test-ids preserved for units.
import { useState } from "react";
import { Avatar } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Message } from "../api/contract";
import { segmentBody } from "../lib/render-body";
import { authorNameOf } from "../lib/author";
import { Attachments } from "./Attachments";
import { EmojiPicker } from "./EmojiPicker";
import styles from "../styles/chat.module.css";

export interface MessageItemProps {
  message: Message;
  currentUserId: common.UserId;
  canModerate: boolean;
  grouped?: boolean; // same author + short gap as the previous row → compact
  mentionsMe?: boolean; // highlight the whole row (yellow rail)
  pinned?: boolean;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onSubmitEdit?: (message: Message, body: string) => void | Promise<void>;
  onDelete?: (message: Message) => void; // opens ConfirmDialog upstream
  onReply?: (message: Message) => void; // open/append in the thread pane
  onOpenThread?: (message: Message) => void;
  onTogglePin?: (message: Message) => void;
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

const QUICK_REACTIONS = ["👍", "🎉", "✅"];

export function MessageItem({
  message,
  currentUserId,
  canModerate,
  grouped = false,
  mentionsMe = false,
  pinned = false,
  resolveUser,
  onToggleReaction,
  onSubmitEdit,
  onDelete,
  onReply,
  onOpenThread,
  onTogglePin,
}: MessageItemProps) {
  const isSystem = message.authorId === null; // system post — no human author, not moderatable
  const isAuthor = message.authorId !== null && message.authorId === currentUserId;
  const isDeleted = message.deletedAt !== null;
  const canEdit = isAuthor && !isDeleted; // authors only — even moderators can't edit others'
  const canDelete = (isAuthor || canModerate) && !isDeleted && !isSystem;
  const authorName = authorNameOf(message.authorId, resolveUser);
  const authorAvatar = (message.authorId !== null ? resolveUser?.(message.authorId)?.avatarUrl : null) ?? undefined;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);

  const startEdit = () => {
    setDraft(message.body);
    setEditing(true);
  };
  const commitEdit = async () => {
    const next = draft.trim();
    if (next.length > 0 && next !== message.body) await onSubmitEdit?.(message, next);
    setEditing(false);
  };

  const rowClasses = [
    styles.messageRow,
    grouped ? styles.grouped : "",
    mentionsMe ? styles.mentionsMe : "",
    pinned ? styles.pinnedRow : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClasses} data-testid="fe6-timeline-message" data-message-id={message.id}>
      {/* hover action bar */}
      {!isDeleted && !editing && (
        <div className={styles.hoverActions} role="toolbar" aria-label="メッセージ操作">
          <EmojiPicker
            align="right"
            direction="down"
            trigger="😊"
            triggerClassName={styles.hoverAction}
            triggerLabel="リアクションを追加"
            testId="fe6-timeline-react"
            onPick={(e) => onToggleReaction?.(message.id, e)}
          />
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
          {onTogglePin && (
            <button
              type="button"
              className={styles.hoverAction}
              aria-label={pinned ? "ピン留めを解除" : "ピン留め"}
              title={pinned ? "ピン留めを解除" : "ピン留め"}
              data-testid="fe6-timeline-pin"
              onClick={() => onTogglePin(message)}
            >
              📌
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className={styles.hoverAction}
              aria-label="編集"
              data-testid="fe6-timeline-edit"
              onClick={startEdit}
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
            {pinned && (
              <span className={styles.pinnedTag} title="ピン留め済み">
                📌 ピン留め
              </span>
            )}
          </div>
        )}

        {isDeleted ? (
          <div className={styles.deleted} data-testid="fe6-timeline-deleted">
            このメッセージは削除されました
          </div>
        ) : editing ? (
          <div className={styles.editBox} data-testid="fe6-timeline-edit-box">
            <textarea
              className={styles.editTextarea}
              value={draft}
              autoFocus
              aria-label="メッセージを編集"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void commitEdit();
                }
              }}
            />
            <div className={styles.editActions}>
              <button type="button" className={styles.editCancel} onClick={() => setEditing(false)}>
                キャンセル
              </button>
              <button
                type="button"
                className={styles.editSave}
                data-testid="fe6-timeline-edit-save"
                onClick={() => void commitEdit()}
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.textBody} data-testid="fe6-timeline-body">
            {segmentBody(message.body).map((seg, i) => {
              switch (seg.type) {
                case "mention":
                  return (
                    <span key={i} className={styles.mention}>
                      @{authorNameOf(seg.userId, resolveUser)}
                    </span>
                  );
                case "code":
                  return (
                    <code key={i} className={styles.inlineCode}>
                      {seg.value}
                    </code>
                  );
                case "codeblock":
                  return (
                    <pre key={i} className={styles.codeBlock}>
                      <code>{seg.value}</code>
                    </pre>
                  );
                case "bold":
                  return (
                    <strong key={i} className={styles.mdBold}>
                      {seg.value}
                    </strong>
                  );
                case "italic":
                  return (
                    <em key={i} className={styles.mdItalic}>
                      {seg.value}
                    </em>
                  );
                case "strike":
                  return (
                    <s key={i} className={styles.mdStrike}>
                      {seg.value}
                    </s>
                  );
                case "link":
                  return (
                    <a key={i} className={styles.mdLink} href={seg.href} target="_blank" rel="noreferrer">
                      {seg.label}
                    </a>
                  );
                default:
                  return <span key={i}>{seg.value}</span>;
              }
            })}
            {grouped && message.editedAt && <span className={styles.editedTag}> (編集済み)</span>}
          </div>
        )}

        {!isDeleted && !editing && message.attachments.length > 0 && <Attachments attachments={message.attachments} />}

        {!isDeleted && !editing && message.reactions.length > 0 && (
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
            <EmojiPicker
              trigger="😊＋"
              triggerClassName={styles.addReaction}
              triggerLabel="リアクションを追加"
              testId="fe6-timeline-add-reaction"
              onPick={(e) => onToggleReaction?.(message.id, e)}
            />
          </div>
        )}

        {!isDeleted && !editing && message.replyCount > 0 && (
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
