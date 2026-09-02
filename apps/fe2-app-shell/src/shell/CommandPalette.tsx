// CommandPalette (P06 グローバルコマンドパレット). A keyboard-first launcher opened with
// Cmd/Ctrl+K from anywhere in the shell. It mirrors the 9-dot AppLauncher's apps as
// runnable commands and adds the global self-service actions (ホームへ / アカウント設定 /
// ログアウト), so a user can switch app or fire an action without touching the mouse.
//
// Composition-only: FE2 wires the command list (apps + actions, gating included) and
// this component renders/dispatches. It owns no router and no auth — every command
// carries its own run(). The palette is portaled to <body> so `position: fixed`
// measures against the viewport and it escapes any ancestor stacking/overflow context.
//
// a11y: the text field is a combobox (aria-expanded/-controls/-activedescendant); the
// results are a listbox of options. Focus stays in the input while ↑/↓ move the active
// option (aria-activedescendant pattern), Enter runs it, Esc closes. Opening restores
// focus to the previously-focused element on close.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@dub/ui";
import type { IconName } from "@dub/ui";
import { isImeComposing } from "@dub/ui";
import { COMMAND_PALETTE_SHORTCUT, matchChord } from "./shortcuts/registry.ts";

export interface PaletteCommand {
  /** Stable id (used for recents + option DOM ids). */
  id: string;
  label: string;
  /** Section heading the command groups under (e.g. "アプリ" / "アクション"). */
  group: string;
  icon?: IconName;
  /** Extra search terms (romaji/aliases) so a Japanese label is also found by ASCII. */
  keywords?: string[];
  /** Greyed + non-runnable (release/permission gated) — kept visible, matching the launcher. */
  disabled?: boolean;
  disabledReason?: string;
  run: () => void;
}

const RECENT_KEY = "dub.cmdk.recent";
const RECENT_MAX = 4;

function loadRecent(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): string[] {
  const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage disabled — recents are best-effort */
  }
  return next;
}

/**
 * True when the keydown is the palette toggle. The chord comes from the shortcut registry
 * (the single source of truth), so the palette binds exactly what the help list shows —
 * there is no second definition to drift ([[dub-api-contract-sot]]).
 */
function isPaletteToggle(e: KeyboardEvent): boolean {
  return matchChord(e, COMMAND_PALETTE_SHORTCUT.chord) && !isImeComposing(e);
}

function matches(cmd: PaletteCommand, q: string): boolean {
  if (!q) return true;
  const hay = [cmd.label, cmd.group, ...(cmd.keywords ?? [])].join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

interface Section {
  group: string;
  items: PaletteCommand[];
}

/** Group filtered commands by section, preserving input order within each group. */
function toSections(commands: PaletteCommand[]): Section[] {
  const order: string[] = [];
  const byGroup = new Map<string, PaletteCommand[]>();
  for (const c of commands) {
    if (!byGroup.has(c.group)) {
      byGroup.set(c.group, []);
      order.push(c.group);
    }
    byGroup.get(c.group)!.push(c);
  }
  return order.map((group) => ({ group, items: byGroup.get(group)! }));
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  testId?: string;
}

export function CommandPalette({ commands, testId = "fe2-cmdk" }: CommandPaletteProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const close = useCallback(() => setOpen(false), []);

  // Global Cmd/Ctrl+K toggle — always mounted so the shortcut works from any screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isPaletteToggle(e)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // On open: reset query/selection, remember focus to restore, and seed recents.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setRecent(loadRecent());
    restoreFocusRef.current = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
    // Focus the input once the portal has committed. rAF gives the browser a frame to
    // mount; a direct focus is the synchronous fallback (and what tests observe).
    inputRef.current?.focus();
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Restore focus to the opener when the palette closes.
  useEffect(() => {
    if (open) return;
    restoreFocusRef.current?.focus?.();
  }, [open]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const filtered = useMemo(() => commands.filter((c) => matches(c, query)), [commands, query]);

  // With an empty query, float recently-used commands to the top (most-recent first),
  // so the palette opens onto "what you just did" — the common re-navigation path.
  const ordered = useMemo(() => {
    if (query || recent.length === 0) return filtered;
    const rank = new Map(recent.map((id, i) => [id, i]));
    const recents = filtered
      .filter((c) => rank.has(c.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
      .map((c) => ({ ...c, group: "最近使った項目" }));
    const rest = filtered.filter((c) => !rank.has(c.id));
    return [...recents, ...rest];
  }, [filtered, query, recent]);

  const sections = useMemo(() => toSections(ordered), [ordered]);
  // Flatten in render order so ↑/↓ traverse the visible list regardless of grouping.
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Keep the active index in range as the list shrinks/grows with the query.
  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  const runAt = useCallback(
    (index: number) => {
      const cmd = flat[index];
      if (!cmd || cmd.disabled) return;
      setRecent(pushRecent(cmd.id));
      close();
      cmd.run();
    },
    [flat, close],
  );

  // Scroll the active option into view as the selection moves via the keyboard.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setActiveIndex((i) => (i + 1) % flat.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(0, flat.length - 1));
      return;
    }
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      runAt(activeIndex);
    }
  };

  if (!open || typeof document === "undefined") return <></>;

  const activeId = flat[activeIndex] ? `${baseId}-opt-${activeIndex}` : undefined;

  return createPortal(
    <div
      className="fe2-cmdk-overlay"
      data-testid={`${testId}-overlay`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="コマンドパレット"
        className="fe2-cmdk-dialog"
        data-testid={testId}
      >
        <div className="fe2-cmdk-search">
          <span className="fe2-cmdk-search-icon" aria-hidden="true">
            <Icon name="search" size="sm" />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="fe2-cmdk-input"
            data-testid={`${testId}-input`}
            placeholder="アプリやアクションを検索…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="fe2-cmdk-kbd" aria-hidden="true">
            Esc
          </kbd>
        </div>

        {flat.length === 0 ? (
          <div className="fe2-cmdk-empty" data-testid={`${testId}-empty`}>
            該当する項目がありません
          </div>
        ) : (
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="コマンド候補"
            className="fe2-cmdk-list"
          >
            {(() => {
              let idx = -1;
              return sections.map((section) => (
                <li key={section.group} role="presentation" className="fe2-cmdk-section">
                  <div className="fe2-cmdk-section-title" role="presentation">
                    {section.group}
                  </div>
                  <ul role="presentation" className="fe2-cmdk-section-items">
                    {section.items.map((cmd) => {
                      idx += 1;
                      const i = idx;
                      const active = i === activeIndex;
                      return (
                        <li
                          key={`${section.group}:${cmd.id}`}
                          id={`${baseId}-opt-${i}`}
                          role="option"
                          aria-selected={active}
                          aria-disabled={cmd.disabled ?? undefined}
                          data-index={i}
                          data-testid={`${testId}-item-${cmd.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`}
                          className={`fe2-cmdk-item${active ? " is-active" : ""}${cmd.disabled ? " is-disabled" : ""}`}
                          title={cmd.disabled ? cmd.disabledReason : undefined}
                          onMouseMove={() => setActiveIndex(i)}
                          onClick={() => runAt(i)}
                        >
                          <span className="fe2-cmdk-item-icon" aria-hidden="true">
                            {cmd.icon ? <Icon name={cmd.icon} size="sm" /> : null}
                          </span>
                          <span className="fe2-cmdk-item-label">{cmd.label}</span>
                          {cmd.disabled && cmd.disabledReason ? (
                            <span className="fe2-cmdk-item-reason">{cmd.disabledReason}</span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ));
            })()}
          </ul>
        )}

        <div className="fe2-cmdk-footer" aria-hidden="true">
          <span>
            <kbd className="fe2-cmdk-kbd">↑</kbd>
            <kbd className="fe2-cmdk-kbd">↓</kbd> 移動
          </span>
          <span>
            <kbd className="fe2-cmdk-kbd">Enter</kbd> 実行
          </span>
          <span>
            <kbd className="fe2-cmdk-kbd">Esc</kbd> 閉じる
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
