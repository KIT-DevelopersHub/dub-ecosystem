// TaskSearchSelect — layer ② composite. A searchable, chip-based task picker
// composed from a plain <input> + a token-driven combobox menu. Domain-free: the
// caller injects the candidate `options` (id + title) and the value/onChange, so
// the SAME core serves both:
//   • 先行タスク (依存) — `multiple` : many chips, optional per-chip action.
//   • 親タスク (親子) — single       : at most one chip; 空(no chip)=無し, 選択=有り.
//
// On focus it opens a dropdown of ALL candidate options (scrollable when there are
// many); typing narrows the list by name. Choose with the mouse OR the keyboard
// (↑/↓ to move, Enter to pick). See docs/FRONTEND_GUIDE.md「how to add a composite」.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isImeComposing } from "@dub/ui";
import styles from "./TaskSearchSelect.module.css";

export interface TaskSearchOption<Id extends string = string> {
  id: Id;
  title: string;
  /** Optional stable task-ID number (e.g. "TK-0026"). When present it is shown before
   *  the title (chip + option row) and is matched by the search query, so a task can be
   *  found BY ID as well as by title. */
  number?: string;
}

/** Optional per-chip secondary action (e.g. 先行→親 promote). Multi mode only. */
export interface TaskChipAction<Id extends string = string> {
  label: string;
  /** Tooltip / aria description for a given option. */
  title: (option: TaskSearchOption<Id>) => string;
  onAct: (id: Id) => void;
}

interface BaseProps<Id extends string> {
  options: readonly TaskSearchOption<Id>[];
  placeholder?: string;
  /** Shown as the input placeholder when there are no options at all. */
  emptyOptionsLabel?: string;
  /** Shown in the menu when a query matches nothing. */
  noMatchLabel?: string;
  disabled?: boolean;
  testId?: string;
}

export interface TaskSearchSelectSingleProps<Id extends string> extends BaseProps<Id> {
  multiple?: false;
  /** Currently-chosen task, or null for「無し」. */
  value: Id | null;
  onChange: (next: Id | null) => void;
  /** Hint rendered under the field (e.g.「空欄なら親なし」). */
  hint?: ReactNode;
}

export interface TaskSearchSelectMultiProps<Id extends string> extends BaseProps<Id> {
  multiple: true;
  value: readonly Id[];
  onChange: (next: Id[]) => void;
  /** Optional secondary action rendered inside every selected chip. */
  chipAction?: TaskChipAction<Id>;
}

export type TaskSearchSelectProps<Id extends string> =
  | TaskSearchSelectSingleProps<Id>
  | TaskSearchSelectMultiProps<Id>;

/**
 * Shared task selector. Single (親タスク) and multi (先行タスク) modes render the
 * same combobox; the only differences are chip count (≤1 vs many) and whether
 * picking replaces or appends.
 */
export function TaskSearchSelect<Id extends string = string>(props: TaskSearchSelectProps<Id>) {
  const { options, placeholder, emptyOptionsLabel, noMatchLabel, disabled, testId } = props;
  const multiple = props.multiple === true;

  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);

  // Currently-selected ids as a stable array for both modes.
  const selectedIds: readonly Id[] = multiple
    ? (props.value as readonly Id[])
    : props.value != null
      ? [props.value as Id]
      : [];
  const selected = selectedIds
    .map((id) => byId.get(id))
    .filter((o): o is TaskSearchOption<Id> => !!o);

  const noOptions = options.length === 0;

  // The candidate list: every not-yet-selected option, narrowed by the query.
  // No cap — the menu scrolls (see .module.css max-height + overflow-y).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        !selectedIds.includes(o.id) &&
        (q === "" ||
          o.title.toLowerCase().includes(q) ||
          (o.number ?? "").toLowerCase().includes(q)),
    );
  }, [options, selectedIds, query]);

  const open = focused && !noOptions;

  // Reset/clamp the keyboard cursor whenever the visible list changes.
  useEffect(() => {
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);
  useEffect(() => {
    if (open) setActiveIndex(0);
  }, [open]);
  // Keep the highlighted row visible while arrowing through a long, scrolled list.
  useEffect(() => {
    if (!open) return;
    const active = menuRef.current?.querySelector('[data-active="true"]');
    // scrollIntoView is unimplemented in jsdom — guard so tests don't throw.
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const commit = (id: Id) => {
    if (multiple) {
      props.onChange([...(props.value as readonly Id[]), id]);
    } else {
      props.onChange(id); // single: pick replaces
    }
    setQuery("");
    inputRef.current?.focus();
  };

  const removeChip = (id: Id) => {
    if (multiple) {
      props.onChange((props.value as readonly Id[]).filter((x) => x !== id));
    } else {
      props.onChange(null); // single: clearing the chip means「無し」
    }
  };

  const listId = testId ? `${testId}-listbox` : undefined;
  const optDomId = (id: Id) => (testId ? `${testId}-opt-${id}` : undefined);

  return (
    <div className={styles.root} data-testid={testId}>
      {selected.length > 0 && (
        <div className={styles.selected}>
          {selected.map((o) => (
            <span
              key={o.id}
              className={styles.chip}
              data-testid={testId ? `${testId}-chip-${o.id}` : undefined}
            >
              {o.number && <span className={styles.optNum}>{o.number}</span>}
              <span className={styles.chipText}>{o.title}</span>
              {multiple && props.chipAction && (
                <button
                  type="button"
                  className={styles.chipAction}
                  onClick={() => props.chipAction!.onAct(o.id)}
                  title={props.chipAction.title(o)}
                  aria-label={props.chipAction.title(o)}
                  data-testid={testId ? `${testId}-promote-${o.id}` : undefined}
                >
                  {props.chipAction.label}
                </button>
              )}
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => removeChip(o.id)}
                aria-label={`${o.title} を外す`}
                data-testid={testId ? `${testId}-remove-${o.id}` : undefined}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.inputWrap}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && filtered[activeIndex] ? optDomId(filtered[activeIndex]!.id) : undefined}
          autoComplete="off"
          className={styles.input}
          placeholder={noOptions ? (emptyOptionsLabel ?? "候補がありません") : (placeholder ?? "タスク名で検索…")}
          value={query}
          disabled={disabled || noOptions}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (composingRef.current || isImeComposing(e)) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) setFocused(true);
              setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              const pick = filtered[activeIndex];
              if (pick) {
                e.preventDefault();
                commit(pick.id);
              }
            } else if (e.key === "Escape") {
              if (open) {
                e.preventDefault();
                inputRef.current?.blur();
              }
            }
          }}
          data-testid={testId ? `${testId}-input` : undefined}
        />

        {open && (
          <div className={styles.menu} id={listId} role="listbox" ref={menuRef}>
            {filtered.map((o, i) => (
              <button
                key={o.id}
                type="button"
                id={optDomId(o.id)}
                role="option"
                aria-selected={i === activeIndex}
                data-active={i === activeIndex ? "true" : undefined}
                className={styles.option}
                // onMouseDown (not onClick) so it fires before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(o.id);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                data-testid={testId ? `${testId}-opt-${o.id}` : undefined}
              >
                {o.number && <span className={styles.optNum}>{o.number}</span>}
                <span className={styles.optionText}>{o.title}</span>
                <span className={styles.optionAdd}>{multiple ? "＋" : "選択"}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className={styles.empty}>{noMatchLabel ?? "一致するタスクがありません"}</div>
            )}
          </div>
        )}
      </div>

      {!multiple && props.hint != null && <span className={styles.hint}>{props.hint}</span>}
    </div>
  );
}
