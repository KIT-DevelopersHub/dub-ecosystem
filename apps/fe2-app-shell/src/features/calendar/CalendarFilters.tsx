// Sidebar filters, split the way people think about the calendar: 予定 (種類 + ラベル)
// and タスク (個人 / チーム + 状態). Each section has its own master checkbox, so
// "タスクだけ消す" is one click and the rows underneath keep their own state.
import { useId, type ReactNode } from "react";
import { IconButton, Select, SkeletonLoader } from "@dub/ui";
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
  title: string;
  rows: FilterRow[];
  loading?: boolean;
  footer?: ReactNode;
}

function FilterCheck({
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
}: {
  groupKey: string;
  title: string;
  sections: FilterSection[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
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
        {sections.map((s) => (
          <div key={s.title}>
            <div className={styles.calSubHead}>{s.title}</div>
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
          </div>
        ))}
      </div>
    </div>
  );
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
