// MessageList — the chat primitive @dub/ui was missing. Renders a scrollable
// message timeline with day dividers, an unread divider, reactions, per-message
// action slots, and pending/failed send states, from a data-agnostic message
// model. Replaces the timeline + message rows FE6 hand-rolled in local CSS.
// Body is a pre-rendered ReactNode and auth-gated actions are injected via render
// props, so this stays domain-free (no @dub/types, no mention/Md logic here).
import { Fragment } from "react";
import type { MessageListProps, ChatMessage } from "../types";
import styles from "./MessageList.module.css";
import { cx } from "../utils/cx";

function needsDivider(messages: ChatMessage[], index: number): boolean {
  if (index === 0) return messages[0]!.dayKey != null;
  const prev = messages[index - 1]!;
  const cur = messages[index]!;
  return cur.dayKey != null && cur.dayKey !== prev.dayKey;
}

export function MessageList({
  messages,
  unreadBeforeId,
  unreadLabel,
  hasOlder,
  onLoadOlder,
  loadOlderLabel,
  onToggleReaction,
  renderActions,
  renderFailedActions,
  emptyState,
  testId,
}: MessageListProps) {
  if (messages.length === 0 && emptyState) {
    return (
      <div className={cx(styles.root)} data-testid={testId}>
        <div className={cx(styles.empty)}>{emptyState}</div>
      </div>
    );
  }

  return (
    <div className={cx(styles.root)} data-testid={testId} role="log" aria-live="polite">
      {hasOlder && (
        <div className={cx(styles.loadOlderWrap)}>
          <button
            type="button"
            className={cx(styles.loadOlder)}
            onClick={onLoadOlder}
            data-testid={testId ? `${testId}-load-older` : undefined}
          >
            {loadOlderLabel ?? "以前のメッセージを読み込む"}
          </button>
        </div>
      )}

      {messages.map((m, i) => {
        const state = m.state ?? "sent";
        return (
          <Fragment key={m.id}>
            {needsDivider(messages, i) && (
              <div className={cx(styles.dayDivider)} data-testid={testId ? `${testId}-day-divider` : undefined}>
                <span>{m.dayLabel ?? m.dayKey}</span>
              </div>
            )}
            {m.id === unreadBeforeId && (
              <div className={cx(styles.unreadDivider)} data-testid={testId ? `${testId}-unread-divider` : undefined}>
                <span>{unreadLabel ?? "ここから未読"}</span>
              </div>
            )}

            <div
              className={cx(
                styles.message,
                state === "pending" && styles.pending,
                state === "failed" && styles.failed,
              )}
              data-testid={testId ? `${testId}-message` : undefined}
              data-message-id={m.id}
              data-state={state}
            >
              <div className={cx(styles.meta)}>
                <span className={cx(styles.author)}>{m.authorName}</span>
                <span className={cx(styles.time)}>{m.timeLabel}</span>
                {m.edited && <span className={cx(styles.tagText)}>(編集済み)</span>}
              </div>

              {m.deleted ? (
                <div className={cx(styles.deleted)} data-testid={testId ? `${testId}-deleted` : undefined}>
                  {m.deletedLabel ?? "このメッセージは削除されました"}
                </div>
              ) : (
                <div className={cx(styles.body)} data-testid={testId ? `${testId}-body` : undefined}>
                  {m.body}
                </div>
              )}

              {!m.deleted && m.reactions && m.reactions.length > 0 && (
                <div className={cx(styles.reactionBar)}>
                  {m.reactions.map((r) => (
                    <button
                      key={r.emoji}
                      type="button"
                      className={cx(styles.reaction, r.mine && styles.reactionMine)}
                      aria-pressed={r.mine ? "true" : "false"}
                      onClick={onToggleReaction ? () => onToggleReaction(m.id, r.emoji) : undefined}
                      data-testid={testId ? `${testId}-reaction` : undefined}
                    >
                      <span aria-hidden="true">{r.emoji}</span>
                      <span className={cx(styles.reactionCount)}>{r.count}</span>
                    </button>
                  ))}
                </div>
              )}

              {state === "failed" ? (
                <div className={cx(styles.failedRow)}>
                  <span className={cx(styles.failedText)}>送信に失敗しました</span>
                  {renderFailedActions?.(m)}
                </div>
              ) : (
                renderActions && !m.deleted && (
                  <div className={cx(styles.actions)}>{renderActions(m)}</div>
                )
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
