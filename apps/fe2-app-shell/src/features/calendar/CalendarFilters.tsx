// Sidebar filters, split the way people think about the calendar: 予定 (種類 + ラベル)
// and タスク (個人 / チーム + 状態). Each section has its own master checkbox, so
// "タスクだけ消す" is one click and the rows underneath keep their own state.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Icon, IconButton, Select, SkeletonLoader } from "@dub/ui";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@dub/app-ui";
import type { identity } from "@dub/types";
import styles from "./calendar.module.css";

export interface FilterRow {
  key: string;
  label: string;
  color: string;
  /** e.g. a remove button for a team added from 他のチーム */
  trailing?: ReactNode;
  note?: string;
}

export interface FilterSection {
  /** stable id for the open/closed state and test ids */
  key: string;
  title: string;
  rows: FilterRow[];
  loading?: boolean;
  footer?: ReactNode;
}

export function FilterCheck({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: FilterRow;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className={`${styles.calItemRow} ${disabled ? styles.calItemOff : ""}`}>
      <label className={styles.calItem}>
        <input
          type="checkbox"
          className={styles.calCheck}
          style={{ ["--cal-color" as string]: row.color }}
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          data-testid={`calendar-filter-${row.key}`}
        />
        <span className={styles.calItemLabel}>
          {row.label}
          {row.note && <span className={styles.calItemNote}>{row.note}</span>}
        </span>
      </label>
      {row.trailing}
    </div>
  );
}

export function FilterGroup({
  groupKey,
  title,
  sections,
  hidden,
  onToggle,
  open,
  onToggleOpen: toggleOpen,
}: {
  groupKey: string;
  title: string;
  sections: FilterSection[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** unfolded sections, ids `${groupKey}/${section.key}` (see useOpenSections) */
  open: ReadonlySet<string>;
  onToggleOpen: (id: string) => void;
}): JSX.Element {
  const off = hidden.has(groupKey);
  return (
    <div className={styles.calGroup} data-testid={`calendar-group-${groupKey}`}>
      <FilterCheck
        row={{ key: groupKey, label: title, color: "var(--dub-color-text-primary)" }}
        checked={!off}
        onToggle={() => onToggle(groupKey)}
      />
      <div className={styles.calGroupBody}>
        {sections.map((s) => {
          const id = `${groupKey}/${s.key}`;
          const isOpen = open.has(id);
          const offCount = s.rows.filter((r) => hidden.has(r.key)).length;
          return (
            <div key={s.key}>
              <button
                type="button"
                className={styles.calSubHead}
                aria-expanded={isOpen}
                onClick={() => toggleOpen(id)}
                data-testid={`calendar-section-${s.key}`}
              >
                <span className={isOpen ? styles.calChevronOpen : styles.calChevron}>
                  <Icon name="chevron-right" size="sm" />
                </span>
                <span className={styles.calSubHeadTitle}>{s.title}</span>
                {!isOpen && offCount > 0 && <span className={styles.calSubHeadNote}>{offCount}件オフ</span>}
              </button>
              {isOpen && (
                <>
                  {s.loading ? (
                    <SkeletonLoader lines={2} />
                  ) : (
                    s.rows.map((r) => (
                      <FilterCheck
                        key={r.key}
                        row={r}
                        checked={!hidden.has(r.key)}
                        disabled={off}
                        onToggle={() => onToggle(r.key)}
                      />
                    ))
                  )}
                  {s.footer}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const OPEN_SECTIONS_STORAGE = "dub.calendar.openFilterSections";

function readOpenSections(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_SECTIONS_STORAGE) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Which filter sections are unfolded. Folded by default so the sidebar stays short; remembered per browser. */
export function useOpenSections(): [ReadonlySet<string>, (id: string) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(readOpenSections);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_SECTIONS_STORAGE, JSON.stringify([...open]));
    } catch {
      // storage full / disabled: folding still works for this session
    }
  }, [open]);
  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return [open, toggle];
}

/** 他のチームのタスクを表示: pick a team to add every task of it, whoever owns it. */
export function AddTeamPicker({
  teams,
  onAdd,
}: {
  teams: readonly { id: string; name: string }[];
  onAdd: (teamId: string) => void;
}): JSX.Element | null {
  const id = useId();
  if (teams.length === 0) return null;
  return (
    <div className={styles.calAddTeam}>
      <label htmlFor={id} className={styles.srOnly}>
        チーム全員の分を表示
      </label>
      <Select
        id={id}
        value={null}
        placeholder="＋ チーム全員分を表示"
        options={teams.map((t) => ({ value: t.id, label: t.name }))}
        onChange={(v) => v && onAdd(v)}
        testId="calendar-add-team"
      />
    </div>
  );
}

export function RemoveTeamButton({ name, onRemove }: { name: string; onRemove: () => void }): JSX.Element {
  return <IconButton name="x" size="sm" aria-label={`${name}の表示をやめる`} onClick={onRemove} />;
}

/**
 * ユーザーを検索 (Google Calendar's "Search for people"): type a name or email, pick a
 * member, and their 予定・タスク are added to the calendar. `exclude` hides people who
 * are already shown (yourself, added ones).
 */
export function PeopleSearch({
  search,
  exclude,
  onAdd,
}: {
  search: (q: string) => Promise<identity.UserSummary[]>;
  exclude: ReadonlySet<string>;
  onAdd: (user: identity.UserSummary) => void;
}): JSX.Element {
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(text.trim(), 250);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["calendar", "people-search", q],
    queryFn: () => search(q),
    enabled: q.length > 0,
    staleTime: 60_000,
  });
  const results = (data ?? []).filter((u) => !exclude.has(u.id));
  const showList = open && text.trim().length > 0;
  const pending = text.trim() !== q || (isFetching && !data);
  useEffect(() => setActive(0), [q]);

  const pick = (u: identity.UserSummary) => {
    onAdd(u);
    setText("");
    setOpen(false);
  };

  return (
    <div className={styles.people} data-testid="calendar-people-search">
      <div className={styles.peopleField}>
        <Icon name="users" size="sm" />
        <input
          className={styles.peopleInput}
          type="search"
          role="combobox"
          aria-label="ユーザーを検索"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && results[active] ? `${listId}-${results[active]!.id}` : undefined}
          placeholder="ユーザーを検索"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && showList && results[active]) {
              e.preventDefault();
              pick(results[active]!);
            } else if (e.key === "Escape") {
              setText("");
              setOpen(false);
            }
          }}
          data-testid="calendar-people-input"
        />
      </div>
      {showList && (
        <div className={styles.peopleList} id={listId} role="listbox" aria-label="ユーザー" data-testid="calendar-people-results">
          {pending ? (
            <SkeletonLoader lines={2} />
          ) : isError ? (
            <p className={styles.peopleEmpty}>検索できませんでした</p>
          ) : results.length === 0 ? (
            <p className={styles.peopleEmpty}>該当するユーザーがいません</p>
          ) : (
            results.map((u, i) => (
              <div
                key={u.id}
                id={`${listId}-${u.id}`}
                role="option"
                aria-selected={i === active}
                className={`${styles.peopleOption} ${i === active ? styles.peopleOptionActive : ""}`}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(u);
                }}
                onMouseEnter={() => setActive(i)}
                data-testid={`calendar-people-option-${u.id}`}
              >
                <span className={styles.peopleAvatar} aria-hidden="true">
                  {u.displayName.slice(0, 1)}
                </span>
                <span className={styles.calItemLabel}>
                  {u.displayName}
                  {u.email && <span className={styles.calItemNote}>{u.email}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
