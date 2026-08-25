import { useMemo, useRef, useState } from "react";
import type { common } from "@dub/types";
import styles from "../styles/app.module.css";

export interface PredecessorOption {
  id: common.TaskId;
  title: string;
}

export interface PredecessorPickerProps {
  options: readonly PredecessorOption[];
  value: readonly common.TaskId[];
  onChange: (next: common.TaskId[]) => void;
  /** When provided, each selected chip gets a 「親に」 action to convert that
   *  predecessor (依存) into the task's parent (親子) — relation-type switching. */
  onPromoteToParent?: (id: common.TaskId) => void;
  testId?: string;
}

const RECENT_KEY = "fe4:recent-predecessors";
const RECENT_MAX = 4;

function readRecent(): common.TaskId[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as common.TaskId[]) : [];
  } catch {
    return [];
  }
}
export function rememberPredecessors(ids: readonly common.TaskId[]): void {
  if (ids.length === 0) return;
  try {
    const prev = readRecent();
    const merged = [...ids, ...prev].filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(merged));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/**
 * Searchable predecessor (parent-task) picker. Instead of listing every task
 * (which grows unbounded), it offers an autocomplete search plus a small set of
 * recently-chosen suggestions — Notion-style combobox behaviour.
 */
export function PredecessorPicker({ options, value, onChange, onPromoteToParent, testId }: PredecessorPickerProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const selected = value.map((id) => byId.get(id)).filter((o): o is PredecessorOption => !!o);

  const recentIds = useMemo(() => {
    const recent = readRecent();
    return recent.filter((id) => byId.has(id) && !value.includes(id)).slice(0, RECENT_MAX);
  }, [byId, value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = options.filter((o) => !value.includes(o.id));
    if (!q) return [];
    return pool.filter((o) => o.title.toLowerCase().includes(q)).slice(0, 8);
  }, [options, value, query]);

  const add = (id: common.TaskId) => {
    onChange([...value, id]);
    setQuery("");
    inputRef.current?.focus();
  };
  const remove = (id: common.TaskId) => onChange(value.filter((x) => x !== id));

  const showRecent = focused && query.trim() === "" && recentIds.length > 0;
  const showMatches = focused && query.trim() !== "";

  return (
    <div className={styles.pp} data-testid={testId}>
      {selected.length > 0 && (
        <div className={styles.ppSelected}>
          {selected.map((o) => (
            <span key={o.id} className={styles.ppChip} data-testid={testId ? `${testId}-chip-${o.id}` : undefined}>
              <span className={styles.ppChipText}>{o.title}</span>
              {onPromoteToParent && (
                <button
                  type="button"
                  className={styles.ppChipPromote}
                  onClick={() => onPromoteToParent(o.id)}
                  title={`「${o.title}」を親タスク（親子）に変換`}
                  aria-label={`${o.title} を親タスクに変換`}
                  data-testid={testId ? `${testId}-promote-${o.id}` : undefined}
                >
                  親に
                </button>
              )}
              <button type="button" className={styles.ppChipX} onClick={() => remove(o.id)} aria-label={`${o.title} を外す`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.ppInputWrap}>
        <input
          ref={inputRef}
          type="text"
          className={styles.ppInput}
          placeholder={options.length === 0 ? "先行にできるタスクがありません" : "タスク名で検索…"}
          value={query}
          disabled={options.length === 0}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          data-testid={testId ? `${testId}-input` : undefined}
        />

        {(showRecent || showMatches) && (
          <div className={styles.ppMenu} role="listbox">
            {showRecent && <div className={styles.ppMenuHint}>最近選んだタスク</div>}
            {(showRecent ? recentIds.map((id) => byId.get(id)!).filter(Boolean) : matches).map((o) => (
              <button
                key={o.id}
                type="button"
                className={styles.ppOption}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(o.id);
                }}
                data-testid={testId ? `${testId}-opt-${o.id}` : undefined}
              >
                <span className={styles.ppOptText}>{o.title}</span>
                <span className={styles.ppOptAdd}>＋</span>
              </button>
            ))}
            {showMatches && matches.length === 0 && <div className={styles.ppEmpty}>一致するタスクがありません</div>}
          </div>
        )}
      </div>
    </div>
  );
}
