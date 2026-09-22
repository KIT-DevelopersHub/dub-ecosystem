// The month/week grid renderer. Pure presentation: it takes prebuilt day cells
// (calendar-grid.ts) and the day→tasks map and lays them out. Shared by month and
// week views (week just passes a 7-cell row and a taller cell variant).
import type { task } from "@dub/types";
import type { DayCell, DayTask } from "./calendar-grid";
import { WEEKDAY_LABELS_JA } from "./calendar-grid";
import { statusVisual } from "./taskVisuals";
import styles from "./calendar.module.css";

/** Max chips shown per day before collapsing to "+N". */
const MAX_CHIPS_PER_DAY = 3;

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

function TaskChip({ dt, onSelect }: { dt: DayTask; onSelect: (t: task.Task) => void }): JSX.Element {
  const v = statusVisual(dt.task.status);
  // A mid-span day renders a slim continuation bar with no title.
  if (dt.isSpan && !dt.isStart) {
    return (
      <div
        className={cx(styles.chip, styles.chipSpanMid)}
        style={{ background: v.bg, color: v.fg }}
        role="presentation"
        aria-hidden="true"
      />
    );
  }
  return (
    <button
      type="button"
      className={styles.chip}
      style={{ background: v.bg, color: v.fg }}
      onClick={() => onSelect(dt.task)}
      title={`${dt.task.title}（${v.label}）`}
      data-testid={`calendar-chip-${dt.task.id}`}
    >
      <span className={styles.chipDot} style={{ background: v.dot }} />
      <span className={styles.chipTitle}>{dt.task.title}</span>
    </button>
  );
}

export function CalendarGrid({
  cells,
  byDay,
  onSelectTask,
  week = false,
}: {
  cells: DayCell[];
  byDay: Map<string, DayTask[]>;
  onSelectTask: (t: task.Task) => void;
  week?: boolean;
}): JSX.Element {
  return (
    <div className={styles.grid} role="grid" aria-label="タスクカレンダー">
      {WEEKDAY_LABELS_JA.map((label, i) => (
        <div
          key={label}
          className={cx(styles.weekdayHead, i === 0 && styles.weekdaySun, i === 6 && styles.weekdaySat)}
          role="columnheader"
        >
          {label}
        </div>
      ))}
      {cells.map((cell) => {
        const tasks = byDay.get(cell.key) ?? [];
        const shown = tasks.slice(0, MAX_CHIPS_PER_DAY);
        const overflow = tasks.length - shown.length;
        return (
          <div
            key={cell.key}
            className={cx(
              styles.cell,
              week && styles.cellWeek,
              !cell.inMonth && styles.cellOutside,
              cell.isToday && styles.cellToday,
            )}
            role="gridcell"
            aria-label={cell.key}
            data-testid={`calendar-day-${cell.key}`}
          >
            <span className={cx(styles.dayNum, cell.isToday && styles.dayNumToday)}>{cell.day}</span>
            <div className={styles.chips}>
              {shown.map((dt, idx) => (
                <TaskChip key={`${dt.task.id}-${idx}`} dt={dt} onSelect={onSelectTask} />
              ))}
              {overflow > 0 && <span className={styles.more}>+{overflow} 件</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
