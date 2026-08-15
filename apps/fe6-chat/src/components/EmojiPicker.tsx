/// <reference lib="dom" />
// Lightweight emoji picker popover. Self-contained (own trigger button + panel,
// closes on outside-click / Esc) so it drops into the message hover bar and the
// composer without nested-button issues. Slack-style quick emoji grid — no
// external emoji dataset, just a curated set covering the common reactions.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "../styles/chat.module.css";

// Curated set (reactions people actually reach for), grouped visually by row.
export const EMOJI_SET: string[] = [
  "👍", "👎", "😀", "😅", "😂", "😍", "🤔", "😮",
  "😢", "😡", "🎉", "🙌", "👏", "🙏", "🔥", "⭐",
  "✅", "❌", "👀", "💯", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🚀", "☕", "🍺", "🍕", "🐛", "💡",
  "📌", "📝", "✨", "😴", "🤝", "👋", "🎨", "🥳",
];

export interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  /** Node rendered as the trigger button's content. */
  trigger: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
  align?: "left" | "right";
  /** Which way the panel opens. "up" (default) for pills near the bottom;
      "down" for the message hover bar which sits above the row. */
  direction?: "up" | "down";
  testId?: string;
}

export function EmojiPicker({
  onPick,
  trigger,
  triggerClassName,
  triggerLabel = "リアクションを追加",
  align = "left",
  direction = "up",
  testId,
}: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className={styles.emojiPickerWrap} ref={wrapRef}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="絵文字を選択"
          className={`${styles.emojiPanel} ${align === "right" ? styles.emojiPanelRight : ""} ${
            direction === "down" ? styles.emojiPanelDown : ""
          }`}
          data-testid="fe6-emoji-panel"
        >
          {EMOJI_SET.map((e) => (
            <button
              key={e}
              type="button"
              className={styles.emojiOption}
              aria-label={e}
              onClick={() => {
                onPick(e);
                setOpen(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
