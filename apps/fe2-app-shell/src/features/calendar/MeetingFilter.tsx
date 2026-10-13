// 「表示するカレンダー」: one checkbox per meeting target (全体 + roles), like Google
// Calendar's left pane. Only filters meetings; tasks are always shown.
import { Checkbox, Skeleton } from "@dub/ui";
import type { meeting } from "@dub/types";
import styles from "./calendar.module.css";

export function MeetingFilter({
  targets,
  visible,
  loading,
  onChange,
}: {
  targets: readonly meeting.MeetingTarget[];
  visible: ReadonlySet<string>;
  loading: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  return (
    <section className={styles.filter} aria-label="表示するカレンダー" data-testid="calendar-meeting-filter">
      <h2 className={styles.filterHead}>表示するカレンダー</h2>
      {loading ? (
        <div className={styles.filterList} data-testid="calendar-meeting-filter-loading" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="text" width="80%" />
          ))}
        </div>
      ) : (
        <div className={styles.filterList}>
          {targets.map((t) => (
            <Checkbox
              key={t.id}
              id={`calendar-meeting-filter-${t.id}`}
              testId={`calendar-meeting-filter-${t.id}`}
              checked={visible.has(t.id)}
              onChange={(on) => {
                const next = new Set(visible);
                if (on) next.add(t.id);
                else next.delete(t.id);
                onChange(targets.map((x) => x.id).filter((id) => next.has(id)));
              }}
              label={
                <span className={styles.filterLabel}>
                  {t.name}
                  <span className={styles.filterCount}>{t.memberCount}人</span>
                </span>
              }
            />
          ))}
        </div>
      )}
      <p className={styles.filterNote}>タスクは常に表示されます</p>
    </section>
  );
}
