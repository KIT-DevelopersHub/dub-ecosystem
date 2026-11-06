// Who gets a keystroke: an open modal owns the keyboard, typing goes to the field, and browser
// chords stay the browser's. Shared by the list shortcuts (GmailApp) and r / a / f (ReadingPane).

export const SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: "c", label: "新規作成" },
  { keys: "/", label: "検索" },
  { keys: "j / k", label: "次 / 前のスレッド" },
  { keys: "o / Enter", label: "開く" },
  { keys: "u", label: "一覧に戻る" },
  { keys: "x", label: "選択" },
  { keys: "s", label: "スター" },
  { keys: "e", label: "アーカイブ" },
  { keys: "#", label: "削除" },
  { keys: "Shift + i", label: "既読にする" },
  { keys: "Shift + u", label: "未読にする" },
  { keys: "r", label: "返信" },
  { keys: "a", label: "全員に返信" },
  { keys: "f", label: "転送" },
  { keys: "z", label: "元に戻す" },
  { keys: "?", label: "ショートカット一覧" },
];

export function modalOpen(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('[role="dialog"], [aria-modal="true"]')) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
}

export function shortcutsBlocked(e: KeyboardEvent): boolean {
  return modalOpen(e.target) || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey;
}
