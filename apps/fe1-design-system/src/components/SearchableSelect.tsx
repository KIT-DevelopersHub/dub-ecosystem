// SearchableSelect — a form-field dropdown whose menu starts with a search box
// (combobox + listbox pattern). The standard picker for "choose one of many" (people,
// teams, …) when a native <select> is too long to scan.
//
//   - trigger is a <button id> so a <label htmlFor> names it (like Select)
//   - open: ArrowDown / ArrowUp / Enter / Space on the trigger, or click
//   - in the menu: type to filter, ArrowUp/Down (skips disabled), Home/End, Enter picks,
//     Escape closes (and does NOT close an enclosing Modal), Tab closes
//   - options may carry a `group` heading; `pinnedValues` float to the top under
//     `pinnedLabel` while the query is empty (e.g. 最近選んだ人)
//   - `loading` renders a skeleton, no match renders `emptyText`
//   - the menu is portalled to <body> with fixed coordinates, so a Modal's scrolling
//     body never clips it (works in dialogs); it flips above when there is no room below
// Domain-free (@dub/ui ①): data comes in through props.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { SearchableSelectOption, SearchableSelectProps } from "../types";
import { Icon } from "./Icon";
import { SkeletonList } from "./Skeleton";
import styles from "./SearchableSelect.module.css";
import { cx } from "../utils/cx";
import { OverlayPortal } from "../utils/overlay";

const norm = (s: string): string => s.normalize("NFKC").toLowerCase();

interface Section<V extends string> {
  heading: string | null;
  items: SearchableSelectOption<V>[];
}

/** Pure: filter by query (label + description) and split into sections. Exported for tests. */
export function buildSections<V extends string>(
  options: readonly SearchableSelectOption<V>[],
  query: string,
  pinnedValues: readonly V[] = [],
  pinnedLabel = "最近選んだもの",
): Section<V>[] {
  const q = norm(query.trim());
  const match = (o: SearchableSelectOption<V>): boolean => !q || norm(`${o.label} ${o.description ?? ""}`).includes(q);
  const byValue = new Map(options.map((o) => [o.value, o] as const));
  const pinned = q
    ? []
    : pinnedValues.map((v) => byValue.get(v)).filter((o): o is SearchableSelectOption<V> => !!o && !o.disabled);
  const pinnedSet = new Set(pinned.map((o) => o.value));
  const sections: Section<V>[] = [];
  if (pinned.length > 0) sections.push({ heading: pinnedLabel, items: pinned });
  const order: (string | null)[] = [];
  const groups = new Map<string | null, SearchableSelectOption<V>[]>();
  for (const o of options) {
    if (pinnedSet.has(o.value) || !match(o)) continue;
    const g = o.group ?? null;
    if (!groups.has(g)) {
      groups.set(g, []);
      order.push(g);
    }
    groups.get(g)!.push(o);
  }
  for (const g of order) sections.push({ heading: g, items: groups.get(g)! });
  return sections;
}

export function SearchableSelect<V extends string = string>({
  id,
  value,
  onChange,
  options,
  placeholder = "選択してください",
  searchPlaceholder = "検索",
  emptyText = "見つかりません",
  disabled,
  invalid,
  loading = false,
  pinnedValues,
  pinnedLabel,
  maxResults = 100,
  testId,
  ...rest
}: SearchableSelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const listId = useId();
  const optionId = (i: number): string => `${listId}-o${i}`;

  const sections = useMemo(
    () => buildSections(options, query, pinnedValues, pinnedLabel),
    [options, query, pinnedValues, pinnedLabel],
  );
  // capped sections with a flat keyboard index per option
  const { shown, flat } = useMemo(() => {
    const out: SearchableSelectOption<V>[] = [];
    const secs: { heading: string | null; items: { o: SearchableSelectOption<V>; i: number }[] }[] = [];
    for (const s of sections) {
      const items: { o: SearchableSelectOption<V>; i: number }[] = [];
      for (const o of s.items) {
        if (out.length >= maxResults) break;
        items.push({ o, i: out.length });
        out.push(o);
      }
      if (items.length > 0) secs.push({ heading: s.heading, items });
    }
    return { shown: secs, flat: out };
  }, [sections, maxResults]);

  const selected = options.find((o) => o.value === value) ?? null;

  const firstEnabled = (from: number, step: 1 | -1): number => {
    for (let i = from; i >= 0 && i < flat.length; i += step) if (!flat[i]!.disabled) return i;
    return -1;
  };

  // reset the highlight to the selected (or first enabled) option whenever the list changes
  useEffect(() => {
    if (!open) return;
    const sel = flat.findIndex((o) => o.value === value && !o.disabled);
    setActive(query === "" && sel >= 0 ? sel : firstEnabled(0, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, flat.length]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // anchor the portalled panel to the trigger (dynamic coordinates → inline style)
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = (): void => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      const below = vh - r.bottom;
      const up = below < 260 && r.top > below;
      setPos({
        left: r.left,
        width: r.width,
        ...(up ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }),
        maxHeight: Math.max(160, (up ? r.top : below) - 16),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (o: SearchableSelectOption<V> | undefined): void => {
    if (!o || o.disabled) return;
    close(true);
    if (o.value !== value) onChange(o.value);
  };

  const move = (step: 1 | -1): void => {
    const next = firstEnabled(active + step, step);
    if (next >= 0) setActive(next);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't let an enclosing Modal close too
      e.nativeEvent.stopImmediatePropagation?.();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(firstEnabled(0, 1));
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(firstEnabled(flat.length - 1, -1));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className={styles.root} ref={rootRef} data-testid={testId}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cx(styles.trigger)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        aria-describedby={rest["aria-describedby"]}
        aria-label={rest["aria-label"]}
        data-placeholder={selected ? undefined : true}
        data-testid={testId ? `${testId}-trigger` : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.value}>{selected ? selected.label : placeholder}</span>
        <Icon name="chevron-down" size="sm" />
      </button>
      {open ? (
        <OverlayPortal>
          <div
            className={styles.panel}
            ref={panelRef}
            style={pos}
            onKeyDown={onPanelKeyDown}
            data-testid={testId ? `${testId}-menu` : undefined}
          >
            <input
              ref={inputRef}
              className={styles.search}
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label={searchPlaceholder}
              aria-activedescendant={active >= 0 && flat.length > 0 ? optionId(active) : undefined}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid={testId ? `${testId}-search` : undefined}
            />
            {loading ? (
              <SkeletonList rows={4} {...(testId ? { testId: `${testId}-loading` } : {})} />
            ) : flat.length === 0 ? (
              <p className={styles.empty} role="status" data-testid={testId ? `${testId}-empty` : undefined}>
                {emptyText}
              </p>
            ) : (
              <ul
                className={styles.list}
                id={listId}
                role="listbox"
                ref={listRef}
                aria-label={rest["aria-label"] ?? placeholder}
              >
                {shown.map((s, si) => {
                  const { items } = s;
                  return (
                    <li key={`${s.heading ?? ""}-${si}`} role="presentation">
                      {s.heading ? (
                        <div className={styles.heading} role="presentation">
                          {s.heading}
                        </div>
                      ) : null}
                      <ul className={styles.group} role="group" aria-label={s.heading ?? undefined}>
                        {items.map(({ o, i }) => (
                          <li
                            key={o.value}
                            id={optionId(i)}
                            data-index={i}
                            role="option"
                            className={styles.option}
                            aria-selected={o.value === value}
                            aria-disabled={o.disabled || undefined}
                            data-active={i === active || undefined}
                            data-testid={o.testId ?? (testId ? `${testId}-option-${o.value || "none"}` : undefined)}
                            onMouseEnter={() => !o.disabled && setActive(i)}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => choose(o)}
                          >
                            <span className={styles.label}>{o.label}</span>
                            {o.description ? <span className={styles.description}>{o.description}</span> : null}
                            {o.value === value ? <Icon name="check" size="sm" /> : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </OverlayPortal>
      ) : null}
    </div>
  );
}
