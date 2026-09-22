// カレンダー — a NEW launcher app that shows the SAME tasks as マイタスク (FE4 list)
// and the ガントチャート, laid out on a monthly/weekly calendar by 期限(dueAt) /
// 期間(startAt〜dueAt). No new backend: it reads the canonical task-service list
// (GET /api/v1/tasks, @dub/types task) via the shell api-client — the API-contract
// SoT — so any task created in マイタスク appears here, and clicking a task deep-links
// back into マイタスク for editing (single write surface over shared data).
import { useMemo, useState } from "react";
import { Button, Card, Icon, PageHeader, SegmentedControl, SkeletonLoader } from "@dub/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { task } from "@dub/types";
import { useCalendarApi, useCalendarCurrentUserId } from "./CalendarProvider.tsx";
import { CalendarGrid } from "./CalendarGrid.tsx";
import { TaskDetailDialog } from "./TaskDetailDialog.tsx";
import {
  addMonths,
  addDays,
  buildMonthGrid,
  buildWeekGrid,
  formatMonthLabel,
  groupTasksByDay,
  startOfMonth,
  startOfWeek,
  type CalendarViewMode,
} from "./calendar-grid";
import { STATUS_ORDER, statusVisual } from "./taskVisuals";
import styles from "./calendar.module.css";

const VIEW_OPTIONS: { value: CalendarViewMode; label: string }[] = [
  { value: "month", label: "月" },
  { value: "week", label: "週" },
];

function todayUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

function weekRangeLabel(anchor: Date): string {
  const s = startOfWeek(anchor);
  const e = addDays(s, 6);
  return `${s.getUTCFullYear()}年${s.getUTCMonth() + 1}月${s.getUTCDate()}日 〜 ${e.getUTCMonth() + 1}月${e.getUTCDate()}日`;
}

export function CalendarScreen(): JSX.Element {
  const api = useCalendarApi();
  const currentUserId = useCalendarCurrentUserId();
  const navigate = useNavigate();
  const [view, setView] = useState<CalendarViewMode>("month");
  const [anchor, setAnchor] = useState<Date>(() => todayUtc());
  const [selected, setSelected] = useState<task.Task | null>(null);

  // Scope to the caller's own tasks (担当/依頼), the only event-less list task-service
  // allows a user — a bare list is rejected by the "/me rule". `enabled` waits for the
  // session so we never fire an unscoped (400-bound) request while auth is loading.
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["calendar", "tasks", currentUserId],
    queryFn: () => api.listMyTasks(currentUserId as NonNullable<typeof currentUserId>),
    enabled: currentUserId != null,
  });

  const tasks = data ?? [];
  const { byDay, undated } = useMemo(() => groupTasksByDay(tasks), [tasks]);
  const today = todayUtc();
  const cells = useMemo(
    () => (view === "month" ? buildMonthGrid(anchor, today) : buildWeekGrid(anchor, today)),
    // today is stable within a render; anchor/view drive the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, anchor],
  );

  const goPrev = () => setAnchor((a) => (view === "month" ? addMonths(a, -1) : addDays(startOfWeek(a), -7)));
  const goNext = () => setAnchor((a) => (view === "month" ? addMonths(a, 1) : addDays(startOfWeek(a), 7)));
  const goToday = () => setAnchor(todayUtc());

  const rangeLabel = view === "month" ? formatMonthLabel(startOfMonth(anchor)) : weekRangeLabel(anchor);

  return (
    <main data-testid="fe2-calendar" className="fe2-page">
      <PageHeader
        testId="fe2-calendar-header"
        title="カレンダー"
        description="マイタスク・ガントと同じタスクを、期限や期間でカレンダーに表示します"
      />

      <div className={styles.page}>
        <div className={styles.toolbar}>
          <div className={styles.nav}>
            <Button variant="secondary" size="sm" onClick={goPrev} testId="calendar-prev">
              {view === "month" ? "前月" : "前週"}
            </Button>
            <Button variant="ghost" size="sm" onClick={goToday} testId="calendar-today">
              今日
            </Button>
            <Button variant="secondary" size="sm" onClick={goNext} testId="calendar-next">
              {view === "month" ? "翌月" : "翌週"}
            </Button>
            <span className={styles.monthLabel} data-testid="calendar-range-label">
              {rangeLabel}
            </span>
          </div>
          <SegmentedControl<CalendarViewMode>
            aria-label="表示切替"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
            testId="calendar-view-toggle"
          />
        </div>

        <div className={styles.legend} data-testid="calendar-legend">
          {STATUS_ORDER.map((s) => {
            const v = statusVisual(s);
            return (
              <span key={s} className={styles.legendItem}>
                <span className={styles.chipDot} style={{ background: v.dot }} />
                {v.label}
              </span>
            );
          })}
        </div>

        {isPending ? (
          <Card testId="calendar-loading">
            <SkeletonLoader lines={8} />
          </Card>
        ) : isError ? (
          <div role="alert" data-testid="calendar-error" className="fe2-inline-error">
            <p>タスクを取得できませんでした。</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              再試行
            </Button>
          </div>
        ) : (
          <>
            <CalendarGrid cells={cells} byDay={byDay} onSelectTask={setSelected} week={view === "week"} />

            {undated.length > 0 && (
              <div className={styles.undated} data-testid="calendar-undated">
                <span className={styles.undatedHead}>
                  <Icon name="clock" /> 日付未設定のタスク（{undated.length}件）
                </span>
                <div className={styles.undatedList}>
                  {undated.map((t) => {
                    const v = statusVisual(t.status);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={styles.chip}
                        style={{ background: v.bg, color: v.fg, width: "auto" }}
                        onClick={() => setSelected(t)}
                        data-testid={`calendar-undated-${t.id}`}
                      >
                        <span className={styles.chipDot} style={{ background: v.dot }} />
                        <span className={styles.chipTitle}>{t.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <TaskDetailDialog
        task={selected}
        onClose={() => setSelected(null)}
        onOpenInTasks={(t) => {
          setSelected(null);
          void navigate({ to: t.eventId ? `/events/${t.eventId}/tasks/${t.id}` : "/me/tasks" });
        }}
      />
    </main>
  );
}
