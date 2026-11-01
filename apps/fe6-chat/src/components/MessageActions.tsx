/// <reference lib="dom" />
// Slack-style 「その他」 menu for a message row, plus the context ChannelPage uses to
// hand it the side-effecting actions (clipboard / toasts / API). Without a provider
// (unit tests, bare renders) only the props-driven items (pin / edit / delete) show.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { common } from "@dub/types";
import type { Message } from "../api/contract";
import { REMINDER_PRESETS, reminderPresetHint, type ReminderPreset } from "../lib/message-prefs";
import styles from "../styles/chat.module.css";

export interface MessageActions {
  isBookmarked: (id: common.MessageId) => boolean;
  isFollowing: (id: common.MessageId) => boolean;
  /** Absent for thread replies (they never count toward channel unread). */
  canMarkUnread: (message: Message) => boolean;
  markUnread: (message: Message) => void;
  toggleBookmark: (message: Message) => void;
  /** A preset (「20分後」…) or a custom date-time (「カスタム…」). */
  addReminder: (message: Message, when: ReminderPreset | Date) => void;
  copyLink: (message: Message) => void;
  toggleFollow: (message: Message) => void;
  copyText: (message: Message) => void;
  forward: (message: Message) => void;
}

export const MessageActionsContext = createContext<MessageActions | null>(null);

export function useMessageActions(): MessageActions | null {
  return useContext(MessageActionsContext);
}

/**
 * Where the panel fits: below the trigger unless its content doesn't fit there and
 * there is more room above (Slack flips it); the height is clamped to the chosen side.
 */
export function placeMenu(
  trigger: { top: number; bottom: number },
  contentHeight: number,
  bounds: { top: number; bottom: number },
): { up: boolean; maxHeight: number } {
  const below = bounds.bottom - trigger.bottom - MENU_MARGIN_PX;
  const above = trigger.top - bounds.top - MENU_MARGIN_PX;
  const need = Math.min(contentHeight, MENU_HEIGHT_PX);
  const up = need > below && above > below;
  return { up, maxHeight: Math.max(0, Math.min(MENU_HEIGHT_PX, up ? above : below)) };
}

/** Visible area the panel may use: the viewport, narrowed by any clipping scroll ancestor (the timeline). */
function clipBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = globalThis.innerHeight;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const o = globalThis.getComputedStyle(a).overflowY;
    if (o === "auto" || o === "scroll" || o === "hidden") {
      const r = a.getBoundingClientRect();
      if (r.bottom > r.top) {
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
    }
  }
  return { top, bottom };
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
  const [customOpen, setCustomOpen] = useState(false);
  // Open toward the roomier side and cap the height to it; the panel scrolls beyond.
  const [place, setPlace] = useState<{ up: boolean; maxHeight: number }>({ up: false, maxHeight: MENU_HEIGHT_PX });
  const ref = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Re-place whenever the content grows (reminder submenu / custom picker), measured
  // from the real content height, so a row near the bottom flips upward instead of
  // cutting the last preset off at the viewport edge.
  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current;
    const p = panelRef.current;
    if (!t || !p) return;
    const next = placeMenu(t.getBoundingClientRect(), p.scrollHeight, clipBounds(t));
    setPlace((cur) => (cur.up === next.up && cur.maxHeight === next.maxHeight ? cur : next));
  }, [open, reminderOpen, customOpen]);

  // Still taller than the room (tiny viewport): scroll the opened submenu into the panel's view.
  useLayoutEffect(() => {
    const p = panelRef.current;
    const sub = subRef.current;
    if (!open || !reminderOpen || !p || !sub) return;
    const bottom = sub.offsetTop + sub.offsetHeight;
    if (bottom > p.scrollTop + p.clientHeight) p.scrollTop = Math.min(sub.offsetTop, bottom - p.clientHeight);
  }, [open, reminderOpen, customOpen, place]);

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
      label: actions.isBookmarked(message.id) ? "後で用の保存を解除" : "後で用に保存",
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
    setCustomOpen(false);
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
        ref={triggerRef}
        onClick={() => {
          setOpen((o) => !o);
          setReminderOpen(false);
          setCustomOpen(false);
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
          ref={panelRef}
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
              {reminderOpen && (
                <div ref={subRef} data-testid="fe6-msg-reminder-sub">
                  {REMINDER_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      className={`${styles.msgMenuItem} ${styles.msgMenuSubItem}`}
                      data-testid={`fe6-msg-reminder-${p.id}`}
                      onClick={() => run(() => actions.addReminder(message, p.id))}
                    >
                      <span>{p.label}</span>
                      <span className={styles.msgMenuHint}>{reminderPresetHint(p.id, new Date())}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={customOpen}
                    className={`${styles.msgMenuItem} ${styles.msgMenuSubItem}`}
                    data-testid="fe6-msg-reminder-custom"
                    onClick={() => setCustomOpen((o) => !o)}
                  >
                    カスタム…
                  </button>
                  {customOpen && <CustomReminderForm onSubmit={(at) => run(() => actions.addReminder(message, at))} />}
                </div>
              )}
            </>
          )}
          {tail.map(row)}
        </div>
      )}
    </span>
  );
}

/** `YYYY-MM-DDTHH:mm` in local time (datetime-local value). */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Default for 「カスタム…」: the next full hour. */
function nextHour(now: Date): Date {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

/** 「カスタム…」 date-time picker inside a menu (also reused by the 後で view). */
export function CustomReminderForm({ onSubmit, initial }: { onSubmit: (at: Date) => void; initial?: Date }) {
  const [value, setValue] = useState(() => toLocalInput(initial ?? nextHour(new Date())));
  const at = new Date(value);
  const valid = !Number.isNaN(at.getTime()) && at.getTime() > Date.now();
  return (
    <form
      className={styles.reminderCustom}
      data-testid="fe6-reminder-custom-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(at);
      }}
    >
      <input
        type="datetime-local"
        className={styles.reminderCustomInput}
        value={value}
        min={toLocalInput(new Date())}
        aria-label="リマインダーの日時"
        data-testid="fe6-reminder-custom-input"
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className={styles.reminderCustomSave} disabled={!valid} data-testid="fe6-reminder-custom-save">
        設定
      </button>
    </form>
  );
}
