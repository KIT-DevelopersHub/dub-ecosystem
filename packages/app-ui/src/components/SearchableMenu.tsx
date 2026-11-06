// SearchableMenu — a header-style dropdown whose panel is a search box + a filterable,
// keyboard-navigable option list (combobox pattern). Data-injected (②): the caller
// passes items / loading / onSelect; nothing is fetched here.
//
// Behaviour mirrors @dub/ui Menu (outside-click + Escape close) and adds:
//   - focus moves to the search box on open; Escape returns focus to the trigger
//   - ArrowUp/Down move over options (disabled ones included, so their reason is
//     readable), Enter selects an enabled option
//   - disabled options stay listed with a one-line reason (why it cannot be chosen)
//   - `loading` renders a skeleton (never an empty-state flash)
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, SkeletonList } from "@dub/ui";
import { useClientFilter } from "../hooks/useClientFilter";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import styles from "./SearchableMenu.module.css";

export interface SearchableMenuItem {
  id: string;
  label: string;
  /** Second line (e.g. an email). Also searched. */
  description?: string;
  /** Non-empty = listed but not selectable; shown under the label. */
  disabledReason?: string;
  testId?: string;
}

export interface SearchableMenuProps {
  /** Trigger content (rendered inside the trigger button). */
  trigger: ReactNode;
  /** Accessible name of the trigger and the panel. */
  label: string;
  items: readonly SearchableMenuItem[];
  onSelect: (item: SearchableMenuItem) => void;
  /** Called when the panel opens/closes (e.g. to start loading items lazily). */
  onOpenChange?: (open: boolean) => void;
  loading?: boolean;
  heading?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  align?: "start" | "end";
  /** Extra row under the list (e.g. a secondary action). */
  footer?: ReactNode;
  /** Render at most this many matches (keeps a big roster snappy). Default 50. */
  maxResults?: number;
  testId?: string;
}

const textOf = (it: SearchableMenuItem): string => `${it.label} ${it.description ?? ""}`;

export function SearchableMenu({
  trigger,
  label,
  items,
  onSelect,
  onOpenChange,
  loading = false,
  heading,
  searchPlaceholder = "検索",
  emptyText = "見つかりません",
  align = "start",
  footer,
  maxResults = 50,
  testId,
}: SearchableMenuProps): JSX.Element {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (i: number): string => `${listId}-opt-${i}`;

  const { results } = useClientFilter(items, query, textOf);
  const shown = results.slice(0, maxResults);
  const nav = useListKeyboardNav({ count: shown.length, resetKey: query, defaultIndex: 0 });

  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) setQuery("");
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (item: SearchableMenuItem | undefined): void => {
    if (!item || item.disabledReason) return;
    setOpen(false);
    onSelect(item);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nav.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nav.move(-1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(shown[nav.activeIndex]);
    }
  };

  return (
    <div className={styles.root} ref={rootRef} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        data-testid={testId ? `${testId}-trigger` : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
        <Icon name="chevron-down" size="sm" />
      </button>
      {open ? (
        <div className={styles.panel} data-align={align} role="dialog" aria-label={label} onKeyDown={onKeyDown}>
          {heading ? <p className={styles.heading}>{heading}</p> : null}
          <input
            ref={inputRef}
            className={styles.search}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={nav.activeIndex >= 0 && shown.length > 0 ? optionId(nav.activeIndex) : undefined}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid={testId ? `${testId}-search` : undefined}
          />
          {loading ? (
            <SkeletonList rows={4} {...(testId ? { testId: `${testId}-loading` } : {})} />
          ) : shown.length === 0 ? (
            <p className={styles.empty} data-testid={testId ? `${testId}-empty` : undefined}>
              {emptyText}
            </p>
          ) : (
            <ul className={styles.list} id={listId} role="listbox" aria-label={label}>
              {shown.map((item, i) => (
                <li
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  className={styles.option}
                  aria-selected={i === nav.activeIndex}
                  aria-disabled={item.disabledReason ? true : undefined}
                  data-active={i === nav.activeIndex}
                  data-testid={item.testId}
                  onMouseEnter={() => nav.setActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <span className={styles.label}>{item.label}</span>
                  {item.description ? <span className={styles.description}>{item.description}</span> : null}
                  {item.disabledReason ? <span className={styles.reason}>{item.disabledReason}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
