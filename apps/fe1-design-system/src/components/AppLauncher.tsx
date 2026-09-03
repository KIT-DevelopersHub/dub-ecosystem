// AppLauncher (凍結案 1-4-3). A Chrome-waffle-style app switcher for the top bar:
// a 3×3 grid "waffle" button that opens a popover of tool tiles. Replaces the
// persistent left rail so feature surfaces (mail/chat) get the full canvas.
//
// IP note: the waffle glyph is a plain self-drawn 3×3 dot grid (no Google mark or
// asset). FE1 stays router-free — the consumer maps `href` to navigation via
// `onSelect`. Tool visibility (role/permission filtering) is decided upstream by
// whoever builds `items`; this component only renders and dispatches.
//
// Filter/keyboard (判断18②): opening the popover shows a filter box that gets focus
// immediately. Typing narrows the grid by case-insensitive substring on the label —
// this is a *display* filter only. Apps are never removed or hidden from the catalog
// ([[dub-never-hide-or-reduce-apps]]); clearing the box restores every tile. ↑/↓ move
// the active tile, Enter opens it, Esc closes. The active option is tracked via
// aria-activedescendant so focus can stay in the box while the user keeps typing.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { AppLauncherProps, AppLauncherItem } from "../types";
import { Icon } from "./Icon";
import { Badge } from "./Display";
import styles from "./AppLauncher.module.css";
import { cx } from "../utils/cx";
import { isImeComposing } from "../utils/keyboard";

/** Self-drawn 3×3 dot grid (waffle). Not Google's asset — nine plain circles. */
function WaffleGlyph(): JSX.Element {
  const cells = [4, 12, 20];
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {cells.flatMap((cy) =>
        cells.map((cx2) => <circle key={`${cx2}-${cy}`} cx={cx2 + 2} cy={cy + 2} r={2.2} fill="currentColor" />),
      )}
    </svg>
  );
}

export function AppLauncher({
  items,
  onSelect,
  label = "アプリ",
  title = "アプリ",
  searchPlaceholder = "アプリを検索",
  testId,
}: AppLauncherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const listId = `${baseId}-list`;
  const optionId = (index: number): string => `${baseId}-opt-${index}`;

  // Visible tiles = case-insensitive substring on the label. Empty query shows all
  // (nothing is dropped from the catalog — this only narrows what is *rendered*).
  const visible = useMemo<AppLauncherItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  // Reset transient state whenever the popover opens, and move focus to the box so
  // the user can type straight away.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(-1);
    // The input is committed to the DOM by the time this effect runs, so focus it
    // directly — the user can type the moment the popover appears.
    searchRef.current?.focus();
    return undefined;
  }, [open]);

  // Keep the active index on a still-visible, enabled tile as the filter changes.
  useEffect(() => {
    setActiveIndex((prev) => {
      if (prev >= 0 && prev < visible.length && !visible[prev]?.disabled) return prev;
      return -1;
    });
  }, [visible]);

  // Close on outside click / Escape so the popover behaves like a menu.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (item: AppLauncherItem): void => {
    if (item.disabled) return;
    setOpen(false);
    onSelect?.(item);
  };

  // Step from `from` in `dir` (+1/-1), wrapping, landing on the next enabled tile.
  const nextEnabled = (from: number, dir: 1 | -1): number => {
    const n = visible.length;
    if (n === 0) return -1;
    for (let step = 1; step <= n; step += 1) {
      const i = (((from + dir * step) % n) + n) % n;
      if (!visible[i]?.disabled) return i;
    }
    return -1; // every visible tile is disabled
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // 変換確定 Enter (IME) must never launch a tile (FRONTEND_GUIDE §IME).
    if (isImeComposing(e)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => nextEnabled(prev < 0 ? -1 : prev, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => nextEnabled(prev < 0 ? 0 : prev, -1));
    } else if (e.key === "Enter") {
      const idx = activeIndex >= 0 ? activeIndex : nextEnabled(-1, 1);
      const item = idx >= 0 ? visible[idx] : undefined;
      if (item) {
        e.preventDefault();
        select(item);
      }
    }
  };

  return (
    <div className={cx(styles.root)} ref={rootRef} data-testid={testId}>
      <button
        type="button"
        className={cx(styles.trigger)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid={testId ? `${testId}-trigger` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <WaffleGlyph />
      </button>
      {open && (
        <div role="dialog" aria-label={title} id={panelId} className={cx(styles.panel)} data-testid="dub-launcher-panel">
          <div className={cx(styles.panelTitle)}>{title}</div>
          <div className={cx(styles.search)}>
            <span className={cx(styles.searchIcon)} aria-hidden="true">
              <Icon name="search" size="sm" />
            </span>
            <input
              ref={searchRef}
              type="text"
              className={cx(styles.searchInput)}
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              data-testid={testId ? `${testId}-search` : "dub-launcher-search"}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          {visible.length === 0 ? (
            <div className={cx(styles.empty)} role="status">
              「{query.trim()}」に一致するアプリはありません
            </div>
          ) : (
            <div className={cx(styles.grid)} role="listbox" id={listId} aria-label={title}>
              {visible.map((item, index): ReactNode => {
                const active = index === activeIndex;
                return (
                  <button
                    key={item.id}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={cx(styles.tile, active && styles.tileActive)}
                    data-testid={
                      testId ? `${testId}-item-${item.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}` : undefined
                    }
                    // Release-gated tiles stay in the grid (消さない) but are greyed +
                    // non-interactive; the reason surfaces as a native tooltip.
                    disabled={item.disabled ?? false}
                    aria-disabled={item.disabled ?? undefined}
                    title={item.disabled ? item.disabledReason : undefined}
                    onMouseMove={() => {
                      if (!item.disabled) setActiveIndex(index);
                    }}
                    onClick={() => select(item)}
                  >
                    <span className={cx(styles.tileIcon)}>
                      {item.icon ? <Icon name={item.icon} size="md" /> : null}
                      {typeof item.badgeCount === "number" && item.badgeCount > 0 ? (
                        <span className={cx(styles.tileBadge)}>
                          <Badge tone="danger">{item.badgeCount > 99 ? "99+" : item.badgeCount}</Badge>
                        </span>
                      ) : null}
                    </span>
                    <span className={cx(styles.tileLabel)}>{item.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
