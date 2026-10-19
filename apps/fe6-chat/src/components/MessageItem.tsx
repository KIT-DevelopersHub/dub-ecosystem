/// <reference lib="dom" />
// Single message row (Slack-style density). Renders:
//  - avatar gutter (full row) or hover-only timestamp (grouped consecutive post)
//  - Md-subset body: text / bold / italic / strike / link / mention / inline
//    code / fenced code blocks
//  - attachments (images inline, files as chips)
//  - reaction pills (+ emoji picker) and a thread reply summary (faces + "N replies")
//  - a Slack-order hover bar (frequent reactions / picker / thread / forward / その他)
//  - inline edit editor (author-only), Enter saves · Esc cancels
// Edit/delete are gated by authorship + can("chat:moderate") (design §6).
// Deleted messages render as a redacted tombstone. Test-ids preserved for units.
import { useMemo, useState } from "react";
import { Avatar, Icon } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Message, TeamSummary } from "../api/contract";
import { MessageBody } from "./MessageBody";
import { LinkPreviews } from "./LinkPreview";
import { Attachments } from "./Attachments";
import { EmojiPicker } from "./EmojiPicker";
import { ReactionEmoji } from "./CustomEmoji";
import { MessageMoreMenu, useMessageActions } from "./MessageActions";
import { topReactions, useMessagePrefs } from "../lib/message-prefs";
import styles from "../styles/chat.module.css";

export interface MessageItemProps {
  message: Message;
  currentUserId: common.UserId;
  canModerate: boolean;
  grouped?: boolean; // same author + short gap as the previous row → compact
  mentionsMe?: boolean; // highlight the whole row (yellow rail)
  pinned?: boolean;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  resolveTeam?: (id: string) => TeamSummary | undefined;
  onToggleReaction?: (id: common.MessageId, emoji: string) => void;
  onSubmitEdit?: (message: Message, body: string) => void | Promise<void>;
  onDelete?: (message: Message) => void; // opens ConfirmDialog upstream
  onReply?: (message: Message) => void; // open/append in the thread pane
  onOpenThread?: (message: Message) => void;
  onTogglePin?: (message: Message) => void;
}

// System posts (chat-service `kind: "system"`) carry `authorId: null`. Never return
// null here — a null name reaches @dub/ui <Avatar> whose initials() does name.trim()
// and throws, taking the whole chat screen down via the error boundary.
function nameOf(id: common.UserId | null, resolve?: MessageItemProps["resolveUser"]): string {
  if (id === null) return "システム";
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

export function MessageItem({
  message,
  currentUserId,
  canModerate,
  grouped = false,
  mentionsMe = false,
  pinned = false,
  resolveUser,
  resolveTeam,
  onToggleReaction,
  onSubmitEdit,
  onDelete,
  onReply,
  onOpenThread,
  onTogglePin,
}: MessageItemProps) {
  const isAuthor = message.authorId === currentUserId;
  const isDeleted = message.deletedAt !== null;
  const canEdit = isAuthor && !isDeleted; // authors only — even moderators can't edit others'
  const canDelete = (isAuthor || canModerate) && !isDeleted;
  const authorName = nameOf(message.authorId, resolveUser);
  const authorAvatar = message.authorId ? (resolveUser?.(message.authorId)?.avatarUrl ?? undefined) : undefined;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const actions = useMessageActions();
  const reactionUsage = useMessagePrefs((s) => s.reactionUsage);
  const recordReaction = useMessagePrefs((s) => s.recordReaction);
  const quickReactions = useMemo(() => topReactions(reactionUsage), [reactionUsage]);
  const bookmarked = actions?.isBookmarked(message.id) ?? false;

  // Only adding counts toward よく使うリアクション (removing your own is not a "use").
  const react = (emoji: string) => {
    const mine = message.reactions.some((r) => r.emoji === emoji && r.userIds.includes(currentUserId));
    if (!mine) recordReaction(emoji);
    onToggleReaction?.(message.id, emoji);
  };

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
      {/* hover action bar (Slack order): frequent reactions · picker · thread · forward · more */}
      {!isDeleted && !editing && (
        <div className={styles.hoverActions} role="toolbar" aria-label="メッセージ操作">
          {quickReactions.map((e) => (
            <button
              key={e}
              type="button"
              className={styles.hoverAction}
              aria-label={`${e} を追加`}
              title={`${e} でリアクション`}
              data-testid="fe6-timeline-quick-reaction"
              onClick={() => react(e)}
            >
              <ReactionEmoji emoji={e} />
            </button>
          ))}
          <EmojiPicker
            align="right"
            direction="down"
            trigger={<Icon name="smile" size="sm" />}
            triggerClassName={styles.hoverAction}
            triggerLabel="他のリアクションを探す"
            testId="fe6-timeline-react"
            onPick={react}
          />
          {onReply && (
            <button
              type="button"
              className={styles.hoverAction}
              aria-label="スレッドで返信する"
              title="スレッドで返信する"
              data-testid="fe6-timeline-reply"
              onClick={() => onReply(message)}
            >
              <Icon name="message-circle" size="sm" />
            </button>
          )}
          {actions && (
            <button
              type="button"
              className={styles.hoverAction}
              aria-label="メッセージを転送する"
              title="メッセージを転送する"
              data-testid="fe6-timeline-forward"
              onClick={() => actions.forward(message)}
            >
              <Icon name="reply" size="sm" className={styles.forwardIcon} />
            </button>
          )}
          <MessageMoreMenu
            message={message}
            pinned={pinned}
            canEdit={canEdit}
            canDelete={canDelete}
            {...(onTogglePin ? { onTogglePin: () => onTogglePin(message) } : {})}
            onEdit={startEdit}
            onDelete={() => onDelete?.(message)}
          />
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
            {bookmarked && (
              <span className={styles.pinnedTag} title="ブックマーク済み" data-testid="fe6-timeline-bookmarked">
                🔖 ブックマーク
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
            <MessageBody body={message.body} resolveUser={resolveUser} resolveTeam={resolveTeam} />
            {grouped && message.editedAt && <span className={styles.editedTag}> (編集済み)</span>}
          </div>
        )}

        {!isDeleted && !editing && <LinkPreviews body={message.body} />}

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
                  onClick={() => react(r.emoji)}
                >
                  <ReactionEmoji emoji={r.emoji} />
                  <span className={styles.reactionCount}>{r.userIds.length}</span>
                </button>
              );
            })}
            <EmojiPicker
              trigger="😊＋"
              triggerClassName={styles.addReaction}
              triggerLabel="リアクションを追加"
              testId="fe6-timeline-add-reaction"
              onPick={react}
            />
          </div>
        )}

        {!isDeleted && !editing && message.replyCount > 0 && (
          <button type="button" className={styles.threadSummary} onClick={() => onOpenThread?.(message)}>
            <span className={styles.threadFaces} aria-hidden>
              <span className={styles.threadFace} style={{ background: "var(--dub-color-brand-600)" }}>
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
