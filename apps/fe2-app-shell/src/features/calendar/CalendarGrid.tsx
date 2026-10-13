// The month/week grid renderer. Pure presentation: it takes prebuilt day cells
// (calendar-grid.ts) and the day→tasks map and lays them out. Shared by month and
// week views (week just passes a 7-cell row and a taller cell variant).
import type { task } from "@dub/types";
import type { DayCell, DayTask } from "./calendar-grid";
import { WEEKDAY_LABELS_JA } from "./calendar-grid";
import type { MeetingOccurrence } from "./meeting-occurrences";
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

/** Small video-camera glyph (the @dub/ui icon set has none) marking a meeting chip. */
export function VideoGlyph(): JSX.Element {
  return (
    <svg className={styles.chipGlyph} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  );
}

function MeetingChip({ occ, onSelect }: { occ: MeetingOccurrence; onSelect: (o: MeetingOccurrence) => void }): JSX.Element {
  const pending = occ.meeting.id.startsWith("tmp_");
  return (
    <button
      type="button"
      className={cx(styles.chip, styles.chipMeeting, pending && styles.chipMeetingPending)}
      onClick={() => onSelect(occ)}
      title={`${occ.time} ${occ.meeting.title}（${occ.meeting.targetName}）`}
      data-testid={`calendar-meeting-${occ.meeting.id}-${occ.dateKey}`}
    >
      <VideoGlyph />
      <span className={styles.chipTime}>{occ.time}</span>
      <span className={styles.chipTitle}>{occ.meeting.title}</span>
    </button>
  );
}

const NO_MEETINGS = new Map<string, MeetingOccurrence[]>();

export function CalendarGrid({
  cells,
  byDay,
  onSelectTask,
  meetingsByDay = NO_MEETINGS,
  onSelectMeeting,
  week = false,
}: {
  cells: DayCell[];
  byDay: Map<string, DayTask[]>;
  onSelectTask: (t: task.Task) => void;
  meetingsByDay?: Map<string, MeetingOccurrence[]>;
  onSelectMeeting?: (o: MeetingOccurrence) => void;
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
        const meetings = meetingsByDay.get(cell.key) ?? [];
        // Meetings first (they have a time), then tasks; one shared chip budget per day.
        const max = MAX_CHIPS_PER_DAY;
        const shownMeetings = meetings.slice(0, max);
        const shown = tasks.slice(0, Math.max(0, max - shownMeetings.length));
        const overflow = tasks.length + meetings.length - shown.length - shownMeetings.length;
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
              {shownMeetings.map((occ) => (
                <MeetingChip key={`m-${occ.meeting.id}`} occ={occ} onSelect={(o) => onSelectMeeting?.(o)} />
              ))}
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
