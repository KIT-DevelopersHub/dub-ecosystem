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
// ([[dub-never-hide-or-reduce-apps]]); clearing the box restores every tile.
//
// Arrow keys move the active tile in 2-D over the *visible* (filtered) grid — the tiles
// are laid out as a CSS grid of N columns, so 1-D next/prev felt wrong (pressing ↓ just
// stepped to the "next" tile, which is the one to the RIGHT). ←/→ step to the left/right
// neighbour (row-sending + wrapping so every tile is reachable); ↑/↓ move one full row
// up/down within the same column (wrapping top⇄bottom, skipping release-gated tiles and
// the empty cells of a ragged last row). The column count is read from the live grid's
// computed `grid-template-columns` so the math always matches what the user sees (with a
// 3-column fallback for non-layout environments like jsdom, matching the CSS default).
// Enter opens the active tile, Esc closes. The active option is tracked via
// aria-activedescendant so focus can stay in the box while the user keeps typing.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { AppLauncherProps, AppLauncherItem } from "../types";
import { Icon } from "./Icon";
import { Badge } from "./Display";
import styles from "./AppLauncher.module.css";
import { cx } from "../utils/cx";
import { isImeComposing } from "../utils/keyboard";
import { OverlayPortal, useScrollLock } from "../utils/overlay";

// P19: below this width the popover becomes a bottom sheet (see AppLauncher.module.css).
// Kept as a single source of truth for the JS/CSS split below — same number as the
// `@media (max-width: 640px)` block in the CSS module.
const MOBILE_SHEET_QUERY = "(max-width: 640px)";

// True once the viewport is narrow enough for the bottom-sheet presentation. Only
// used to decide WHERE the panel renders (portalled to <body> vs inline) — the
// visual difference itself stays CSS/width-driven via MOBILE_SHEET_QUERY above.
// Defensive about environments without `matchMedia` (older engines, some test
// runners): falls back to `false`, i.e. the existing inline desktop popover.
function useIsMobileSheet(query: string): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [matches, setMatches] = useState<boolean>(() => (supported ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (!supported) return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    // addEventListener is the modern API; addListener is the Safari <14 fallback.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query, supported]);

  return matches;
}

/** Renders `children` in place, or portalled to <body> when `when` is true. */
function MaybePortal({ when, children }: { when: boolean; children: ReactNode }): JSX.Element {
  return when ? <OverlayPortal>{children}</OverlayPortal> : <>{children}</>;
}

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
  // P19: at mobile widths the panel is portalled to <body> and rendered as a
  // bottom sheet — see useIsMobileSheet's doc comment for why the portal is
  // required (the sticky header's backdrop-filter would otherwise become the
  // `position: fixed` containing block instead of the real viewport).
  const isMobileSheet = useIsMobileSheet(MOBILE_SHEET_QUERY);
  useScrollLock(open && isMobileSheet);
  const rootRef = useRef<HTMLDivElement>(null);
  // Portalled content (mobile sheet) is NOT a DOM descendant of rootRef even
  // though it's still a React-tree descendant, so the native mousedown listener
  // below needs its own ref to recognise clicks inside the panel as "inside".
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
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
      const target = e.target as Node;
      const insideRoot = rootRef.current?.contains(target) ?? false;
      const insidePanel = panelRef.current?.contains(target) ?? false; // portalled sheet
      if (!insideRoot && !insidePanel) setOpen(false);
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

  // Live column count of the rendered grid. Read from the computed
  // `grid-template-columns` (resolved to concrete tracks, e.g. "84px 84px 84px" → 3) so
  // the ↑/↓ row-step always matches what the user sees, even if the CSS becomes
  // responsive later. Falls back to 3 (the CSS default `repeat(3, …)`) when the layout
  // engine can't resolve tracks — e.g. jsdom in tests, or before first paint.
  const getColumns = (): number => {
    const el = gridRef.current;
    if (el && typeof getComputedStyle === "function") {
      const tracks = getComputedStyle(el).gridTemplateColumns;
      if (tracks && tracks !== "none") {
        const count = tracks.trim().split(/\s+/).filter(Boolean).length;
        if (count > 0) return count;
      }
    }
    return 3;
  };

  // Step from `from` by a linear offset (+1/-1), wrapping over the whole visible list and
  // landing on the next enabled tile. Backs ←/→ (right/left neighbour, row-sending).
  const nextEnabled = (from: number, dir: 1 | -1): number => {
    const n = visible.length;
    if (n === 0) return -1;
    for (let step = 1; step <= n; step += 1) {
      const i = (((from + dir * step) % n) + n) % n;
      if (!visible[i]?.disabled) return i;
    }
    return -1; // every visible tile is disabled
  };

  // Move one row up/down (drow -1/+1) within the SAME column, wrapping top⇄bottom and
  // skipping both release-gated tiles and the empty cells of a ragged last row. Backs ↑/↓.
  const rowStep = (from: number, drow: 1 | -1): number => {
    const n = visible.length;
    if (n === 0) return -1;
    const cols = Math.max(1, getColumns());
    const rows = Math.ceil(n / cols);
    const start = from < 0 ? 0 : from;
    const col = start % cols;
    const baseRow = Math.floor(start / cols);
    for (let step = 1; step <= rows; step += 1) {
      const row = (((baseRow + drow * step) % rows) + rows) % rows;
      const cand = row * cols + col;
      if (cand < n && !visible[cand]?.disabled) return cand;
    }
    return from; // no other enabled tile in this column — stay put
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // 変換確定 Enter (IME) must never launch a tile (FRONTEND_GUIDE §IME).
    if (isImeComposing(e)) return;
    // First arrow press (nothing active yet) lands on the first enabled tile so the user
    // has an anchor; subsequent presses move directionally from there.
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < 0 ? nextEnabled(-1, 1) : nextEnabled(prev, 1)));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < 0 ? nextEnabled(-1, 1) : nextEnabled(prev, -1)));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < 0 ? nextEnabled(-1, 1) : rowStep(prev, 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < 0 ? nextEnabled(-1, 1) : rowStep(prev, -1)));
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
        <MaybePortal when={isMobileSheet}>
          {/* Mobile-only scrim behind the bottom sheet (P19). Hidden on desktop via
              CSS — the popover has no backdrop there. Tapping it closes the sheet,
              same as the existing outside-click/Escape handling above. */}
          <div
            className={cx(styles.backdrop)}
            aria-hidden="true"
            data-testid={testId ? `${testId}-backdrop` : "dub-launcher-backdrop"}
            onClick={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-label={title}
            id={panelId}
            className={cx(styles.panel)}
            data-testid="dub-launcher-panel"
          >
          {/* Drag-handle affordance, shown only when the panel renders as a bottom
              sheet (mobile). Decorative — dismissal is via scrim tap/outside-click/Esc,
              not a drag gesture. */}
          <div
            className={cx(styles.dragHandle)}
            aria-hidden="true"
            data-testid={testId ? `${testId}-drag-handle` : "dub-launcher-drag-handle"}
          />
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
            <div
              ref={gridRef}
              className={cx(styles.grid)}
              role="listbox"
              id={listId}
              aria-label={title}
              // Liveness marker + self-doc: arrow keys navigate this listbox in 2-D over
              // the visible grid (↑/↓ by row, ←/→ by neighbour). See onSearchKeyDown.
              data-nav="fe1-launcher-grid-2d"
            >
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
        </MaybePortal>
      )}
    </div>
  );
}
