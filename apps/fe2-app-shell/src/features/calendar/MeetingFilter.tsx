// Sidebar「ミーティング」: one checkbox per meeting calendar (全体 + roles), like Google
// Calendar's 他のカレンダー. Only filters meetings; tasks keep their own toggles.
import { SkeletonLoader } from "@dub/ui";
import type { meeting } from "@dub/types";
import { MEETING_VISUAL } from "./taskVisuals";
import styles from "./calendar.module.css";

export function MeetingFilter({
  targets,
  visible,
  loading,
  headAction,
  notice,
  onChange,
}: {
  targets: readonly meeting.MeetingTarget[];
  visible: ReadonlySet<string>;
  loading: boolean;
  /** Small control beside the heading (招待を同期). */
  headAction?: JSX.Element | null;
  /** Shown above the list (shared account not connected, …). */
  notice?: JSX.Element | null;
  onChange: (next: string[]) => void;
}): JSX.Element {
  return (
    <section aria-label="ミーティング" data-testid="calendar-meeting-filter">
      <div className={styles.calListHeadRow}>
        <div className={styles.calListHead}>ミーティング</div>
        {headAction}
      </div>
      {notice}
      {loading ? (
        <div data-testid="calendar-meeting-filter-loading" aria-busy="true">
          <SkeletonLoader lines={3} />
        </div>
      ) : (
        targets.map((t) => (
          <label key={t.id} className={styles.calItem}>
            <input
              type="checkbox"
              className={styles.calCheck}
              style={{ ["--cal-color" as string]: MEETING_VISUAL.color }}
              checked={visible.has(t.id)}
              onChange={(e) => {
                const next = new Set(visible);
                if (e.target.checked) next.add(t.id);
                else next.delete(t.id);
                onChange(targets.map((x) => x.id).filter((id) => next.has(id)));
              }}
              data-testid={`calendar-meeting-filter-${t.id}`}
            />
            {t.name}
            <span className={styles.calCount}>{t.memberCount}人</span>
          </label>
        ))
      )}
    </section>
  );
}
