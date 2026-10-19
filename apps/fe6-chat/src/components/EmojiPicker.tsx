/// <reference lib="dom" />
// Lightweight emoji picker popover. Self-contained (own trigger button + panel,
// closes on outside-click / Esc) so it drops into the message hover bar and the
// composer without nested-button issues. Slack-style quick emoji grid — no
// external emoji dataset, just a curated set covering the common reactions.
// Inside a CustomEmojiProvider it gains a 「カスタム」 tab: the workspace's custom
// emoji (name search, skeleton while loading); picking one yields ":name:".
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SegmentedControl, Skeleton, TextField } from "@dub/ui";
import { CustomEmojiImage, useCustomEmojis } from "./CustomEmoji";
import { CUSTOM_EMOJI_MARKER, filterCustomEmojis, toShortcode } from "../lib/custom-emoji";
import styles from "../styles/chat.module.css";

// Curated set (reactions people actually reach for), grouped visually by row.
export const EMOJI_SET: string[] = [
  "👍", "👎", "😀", "😅", "😂", "😍", "🤔", "😮",
  "😢", "😡", "🎉", "🙌", "👏", "🙏", "🔥", "⭐",
  "✅", "❌", "👀", "💯", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🚀", "☕", "🍺", "🍕", "🐛", "💡",
  "📌", "📝", "✨", "😴", "🤝", "👋", "🎨", "🥳",
];

type PickerTab = "standard" | "custom";

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
  const [tab, setTab] = useState<PickerTab>("standard");
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const ctx = useCustomEmojis();
  // No dead-end tab: hidden when the workspace has no custom emoji and the caller can't import.
  const custom = ctx && (ctx.emojis === null || ctx.emojis.length > 0 || ctx.openImport) ? ctx : null;

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

  const pick = (emoji: string) => {
    onPick(emoji);
    setOpen(false);
  };

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
          {custom && (
            <SegmentedControl<PickerTab>
              options={[
                { value: "standard", label: "標準", testId: "fe6-emoji-tab-standard" },
                { value: "custom", label: "カスタム", testId: "fe6-emoji-tab-custom" },
              ]}
              value={tab}
              onChange={setTab}
              size="sm"
              aria-label="絵文字の種類"
            />
          )}
          {custom && tab === "custom" ? (
            <CustomEmojiTab
              onPick={(name) => pick(toShortcode(name))}
              onImport={
                custom.openImport
                  ? () => {
                      setOpen(false);
                      custom.openImport?.();
                    }
                  : undefined
              }
            />
          ) : (
            <div className={styles.emojiGrid}>
              {EMOJI_SET.map((e) => (
                <button key={e} type="button" className={styles.emojiOption} aria-label={e} onClick={() => pick(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function CustomEmojiTab({ onPick, onImport }: { onPick: (name: string) => void; onImport?: () => void }) {
  const custom = useCustomEmojis();
  const [query, setQuery] = useState("");
  const searchId = useId();
  if (!custom) return null;
  const list = custom.emojis;
  const shown = list ? filterCustomEmojis(list, query) : [];

  return (
    <div className={styles.customEmojiTab} data-feature={CUSTOM_EMOJI_MARKER} data-testid="fe6-emoji-custom">
      <TextField id={searchId} value={query} onChange={setQuery} placeholder="名前で検索" size="sm" testId="fe6-emoji-custom-search" />
      {list === null ? (
        <div className={styles.emojiGrid} role="status" aria-label="カスタム絵文字を読み込み中" data-testid="fe6-emoji-custom-loading">
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} className={styles.emojiOption}>
              <Skeleton variant="rect" width={22} height={22} />
            </span>
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className={styles.customEmojiEmpty}>{custom.failed ? "カスタム絵文字を読み込めませんでした。" : "カスタム絵文字はまだありません。"}</p>
      ) : shown.length === 0 ? (
        <p className={styles.customEmojiEmpty}>「{query}」に一致する絵文字はありません。</p>
      ) : (
        <div className={`${styles.emojiGrid} ${styles.customEmojiGrid}`}>
          {shown.map((e) => (
            <button
              key={e.name}
              type="button"
              className={styles.emojiOption}
              aria-label={toShortcode(e.name)}
              title={toShortcode(e.name)}
              data-testid="fe6-emoji-custom-option"
              onClick={() => onPick(e.name)}
            >
              <CustomEmojiImage name={e.name} lazy className={styles.customEmojiPick} />
            </button>
          ))}
        </div>
      )}
      {onImport && (
        <button type="button" className={styles.customEmojiImport} onClick={onImport} data-testid="fe6-emoji-import-open">
          ⇩ Slack の絵文字を取り込む
        </button>
      )}
    </div>
  );
}
