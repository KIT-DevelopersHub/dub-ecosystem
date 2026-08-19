// TaskSearchSelect — layer ② composite. A searchable, chip-based task picker
// composed from a plain <input> + a token-driven combobox menu. Domain-free: the
// caller injects the candidate `options` (id + title) and the value/onChange, so
// the SAME core serves both:
//   • 先行タスク (依存) — `multiple` : many chips, optional per-chip action.
//   • 親タスク (親子) — single       : at most one chip; 空(no chip)=無し, 選択=有り.
//
// Instead of listing every task (which grows unbounded) it offers incremental
// name search plus an optional set of recently-chosen suggestions (Notion-style
// combobox). See docs/FRONTEND_GUIDE.md「how to add a composite」.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { isImeComposing } from "@dub/ui";
import styles from "./TaskSearchSelect.module.css";

export interface TaskSearchOption<Id extends string = string> {
  id: Id;
  title: string;
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
  /** Shown under the menu when a query matches nothing. */
  noMatchLabel?: string;
  /** localStorage key for the "最近選んだタスク" suggestions; omit to disable recents. */
  recentKey?: string;
  /** Shown on empty focus when `recentKey` is set but there's no history yet, so the
   *  feature is discoverable before any task has been chosen. */
  recentsEmptyLabel?: string;
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

// On focus (empty query) we suggest at most this many recently-chosen tasks — a
// short「最近選んだタスク」shortlist, not a full history dump. Fixed at 2 so the
// suggestion never crowds the field; typing switches to full search results.
const RECENT_MAX = 2;
const RECENT_STORE_MAX = 12;

function readRecent(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** Persist recently-chosen task ids under `key` (most-recent first, de-duped). */
export function rememberTaskSearch(key: string, ids: readonly string[]): void {
  if (!key || ids.length === 0) return;
  try {
    const prev = readRecent(key);
    const merged = [...ids, ...prev].filter((v, i, a) => a.indexOf(v) === i).slice(0, RECENT_STORE_MAX);
    localStorage.setItem(key, JSON.stringify(merged));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/**
 * Shared searchable task selector. Single (親タスク) and multi (先行タスク) modes
 * render the same combobox; the only differences are chip count (≤1 vs many) and
 * whether picking replaces or appends.
 */
export function TaskSearchSelect<Id extends string = string>(props: TaskSearchSelectProps<Id>) {
  const { options, placeholder, emptyOptionsLabel, noMatchLabel, recentKey, recentsEmptyLabel, disabled, testId } = props;
  const multiple = props.multiple === true;

  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const recentIds = useMemo(() => {
    if (!recentKey) return [] as Id[];
    return readRecent(recentKey)
      .filter((id): id is Id => byId.has(id as Id) && !selectedIds.includes(id as Id))
      .slice(0, RECENT_MAX);
  }, [recentKey, byId, selectedIds]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as TaskSearchOption<Id>[];
    return options
      .filter((o) => !selectedIds.includes(o.id) && o.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [options, selectedIds, query]);

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

  // Open the recents dropdown on empty focus whenever the feature is enabled
  // (recentKey set + options exist) — even with NO history yet, so the menu shows
  // a "まだありません" placeholder and the feature is visibly present from the start.
  const recentsEnabled = !!recentKey && !noOptions;
  const showRecent = focused && query.trim() === "" && recentsEnabled;
  const showMatches = focused && query.trim() !== "";
  const menuOptions = showRecent ? recentIds.map((id) => byId.get(id)!).filter(Boolean) : matches;
  const listId = testId ? `${testId}-listbox` : undefined;

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
          aria-expanded={showRecent || showMatches}
          aria-controls={showRecent || showMatches ? listId : undefined}
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
            // Enter picks the first match — fast keyboard flow.
            if (e.key === "Enter" && matches.length > 0) {
              e.preventDefault();
              commit(matches[0]!.id);
            }
          }}
          data-testid={testId ? `${testId}-input` : undefined}
        />

        {(showRecent || showMatches) && (
          <div className={styles.menu} id={listId} role="listbox">
            {showRecent && <div className={styles.menuHint}>最近選んだタスク</div>}
            {menuOptions.map((o) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={false}
                className={styles.option}
                // onMouseDown (not onClick) so it fires before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(o.id);
                }}
                data-testid={testId ? `${testId}-opt-${o.id}` : undefined}
              >
                <span className={styles.optionText}>{o.title}</span>
                <span className={styles.optionAdd}>{multiple ? "＋" : "選択"}</span>
              </button>
            ))}
            {showRecent && recentIds.length === 0 && (
              <div className={styles.empty} data-testid={testId ? `${testId}-recents-empty` : undefined}>
                {recentsEmptyLabel ?? "最近選んだタスクはまだありません"}
              </div>
            )}
            {showMatches && matches.length === 0 && (
              <div className={styles.empty}>{noMatchLabel ?? "一致するタスクがありません"}</div>
            )}
          </div>
        )}
      </div>

      {!multiple && props.hint != null && <span className={styles.hint}>{props.hint}</span>}
    </div>
  );
}
