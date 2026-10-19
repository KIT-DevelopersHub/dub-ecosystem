/// <reference lib="dom" />
// Slack-style 「その他」 menu for a message row, plus the context ChannelPage uses to
// hand it the side-effecting actions (clipboard / toasts / API). Without a provider
// (unit tests, bare renders) only the props-driven items (pin / edit / delete) show.
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { common } from "@dub/types";
import type { Message } from "../api/contract";
import { REMINDER_PRESETS, type ReminderPreset } from "../lib/message-prefs";
import styles from "../styles/chat.module.css";

export interface MessageActions {
  isBookmarked: (id: common.MessageId) => boolean;
  isFollowing: (id: common.MessageId) => boolean;
  /** Absent for thread replies (they never count toward channel unread). */
  canMarkUnread: (message: Message) => boolean;
  markUnread: (message: Message) => void;
  toggleBookmark: (message: Message) => void;
  addReminder: (message: Message, preset: ReminderPreset) => void;
  copyLink: (message: Message) => void;
  toggleFollow: (message: Message) => void;
  copyText: (message: Message) => void;
  forward: (message: Message) => void;
}

export const MessageActionsContext = createContext<MessageActions | null>(null);

export function useMessageActions(): MessageActions | null {
  return useContext(MessageActionsContext);
}

// Matches .msgMenuPanel max-height; the panel scrolls beyond it (reminder list open).
const MENU_HEIGHT_PX = 480;
const MENU_MARGIN_PX = 12;

type Item = { id: string; label: string; onSelect: () => void; danger?: boolean; divider?: boolean; testId?: string };

export function MessageMoreMenu({
  message,
  pinned,
  canEdit,
  canDelete,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  message: Message;
  pinned: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onTogglePin?: () => void;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const actions = useMessageActions();
  const [open, setOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  // Open toward the roomier side and cap the height to it; the panel scrolls beyond.
  const [place, setPlace] = useState<{ up: boolean; maxHeight: number }>({ up: false, maxHeight: MENU_HEIGHT_PX });
  const ref = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items: Item[] = [];
  if (actions) {
    if (actions.canMarkUnread(message)) {
      items.push({ id: "unread", label: "未読にする", onSelect: () => actions.markUnread(message), testId: "fe6-msg-mark-unread" });
    }
    items.push({
      id: "bookmark",
      label: actions.isBookmarked(message.id) ? "ブックマークから削除" : "ブックマークに追加",
      onSelect: () => actions.toggleBookmark(message),
      testId: "fe6-msg-bookmark",
    });
  }
  const tail: Item[] = [];
  if (actions) {
    tail.push(
      { id: "link", label: "リンクをコピー", onSelect: () => actions.copyLink(message), divider: true, testId: "fe6-msg-copy-link" },
      {
        id: "follow",
        label: actions.isFollowing(message.threadRootId ?? message.id) ? "新しい返信の通知をオフにする" : "新しい返信の通知を受け取る",
        onSelect: () => actions.toggleFollow(message),
        testId: "fe6-msg-follow",
      },
      { id: "copy", label: "メッセージをコピーする", onSelect: () => actions.copyText(message), testId: "fe6-msg-copy-text" },
    );
  }
  if (onTogglePin) {
    tail.push({
      id: "pin",
      label: pinned ? "チャンネルからピン留めを外す" : "チャンネルへピン留めする",
      onSelect: onTogglePin,
      divider: true,
      testId: "fe6-timeline-pin",
    });
  }
  if (canEdit) tail.push({ id: "edit", label: "メッセージを編集", onSelect: onEdit, divider: true, testId: "fe6-timeline-edit" });
  if (canDelete) {
    tail.push({
      id: "delete",
      label: "メッセージを削除",
      onSelect: () => onDelete?.(),
      danger: true,
      divider: !canEdit,
      testId: "fe6-timeline-delete",
    });
  }

  if (items.length === 0 && tail.length === 0) return null;

  const run = (fn: () => void) => {
    setOpen(false);
    setReminderOpen(false);
    // Chrome keeps focus on the clicked item, which would pin the hover bar open.
    (document.activeElement as HTMLElement | null)?.blur?.();
    fn();
  };
  const row = (it: Item) => (
    <div key={it.id}>
      {it.divider && <div role="separator" className={styles.msgMenuSeparator} />}
      <button
        type="button"
        role="menuitem"
        className={`${styles.msgMenuItem} ${it.danger ? styles.msgMenuDanger : ""}`}
        data-testid={it.testId}
        onClick={() => run(it.onSelect)}
      >
        {it.label}
      </button>
    </div>
  );

  return (
    <span className={styles.msgMenuWrap} ref={ref}>
      <button
        type="button"
        className={styles.hoverAction}
        aria-label="その他"
        title="その他"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="fe6-msg-more"
        onClick={(e) => {
          // Rows near the bottom of the viewport open the panel upward so it isn't clipped.
          const rect = e.currentTarget.getBoundingClientRect();
          const below = globalThis.innerHeight - rect.bottom - MENU_MARGIN_PX;
          const above = rect.top - MENU_MARGIN_PX;
          const up = below < MENU_HEIGHT_PX && above > below;
          setPlace({ up, maxHeight: Math.min(MENU_HEIGHT_PX, up ? above : below) });
          setOpen((o) => !o);
          setReminderOpen(false);
        }}
      >
        ⋮
      </button>
      {open && (
        <div
          id={panelId}
          role="menu"
          aria-label="メッセージのその他の操作"
          className={`${styles.msgMenuPanel} ${place.up ? styles.msgMenuUp : ""}`}
          style={{ maxHeight: place.maxHeight }}
          data-testid="fe6-msg-menu"
        >
          {items.map(row)}
          {actions && (
            <>
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={reminderOpen}
                className={styles.msgMenuItem}
                data-testid="fe6-msg-reminder"
                onClick={() => setReminderOpen((o) => !o)}
              >
                <span>リマインダーを追加</span>
                <span className={styles.msgMenuChevron} aria-hidden>
                  {reminderOpen ? "▾" : "▸"}
                </span>
              </button>
              {reminderOpen &&
                REMINDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    className={`${styles.msgMenuItem} ${styles.msgMenuSubItem}`}
                    data-testid={`fe6-msg-reminder-${p.id}`}
                    onClick={() => run(() => actions.addReminder(message, p.id))}
                  >
                    {p.label}
                  </button>
                ))}
            </>
          )}
          {tail.map(row)}
        </div>
      )}
    </span>
  );
}
