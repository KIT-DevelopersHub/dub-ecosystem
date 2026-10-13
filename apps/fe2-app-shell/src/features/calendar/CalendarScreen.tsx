// カレンダー — a NEW launcher app that shows the SAME tasks as マイタスク (FE4 list)
// and the ガントチャート, laid out on a monthly/weekly calendar by 期限(dueAt) /
// 期間(startAt〜dueAt). No new backend: it reads the canonical task-service list
// (GET /api/v1/tasks, @dub/types task) via the shell api-client — the API-contract
// SoT — so any task created in マイタスク appears here, and clicking a task deep-links
// back into マイタスク for editing (single write surface over shared data).
import { useMemo, useState } from "react";
import { useToast } from "@dub/ui";
import { Button, Card, Icon, PageHeader, SegmentedControl, SkeletonLoader } from "@dub/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { meeting, task } from "@dub/types";
import { useCalendarApi, useCalendarCurrentUserId } from "./CalendarProvider.tsx";
import { CalendarGrid, VideoGlyph } from "./CalendarGrid.tsx";
import { MeetingDetailDialog } from "./MeetingDetailDialog.tsx";
import { MeetingFilter } from "./MeetingFilter.tsx";
import { MeetingFormDialog } from "./MeetingFormDialog.tsx";
import { loadVisibleTargets, saveVisibleTargets } from "./meeting-form";
import { groupOccurrencesByDay, type MeetingOccurrence } from "./meeting-occurrences";
import { useMeetingMutations, useMeetingTargetsQuery, useMeetingsAccess, useMeetingsQuery } from "./useMeetings.tsx";
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

/** Liveness marker for the meetings feature (shipped in the bundle; checked by verify:live). */
export const MEETINGS_FEATURE_MARKER = "cal-meet-v1";

/** Opens Drive共有 > 設定 on load (driveshare/DriveShareSettings settingsOpenOnLoad). */
const DRIVE_SETTINGS_URL = "/driveshare?setting=google-account";

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
  const toast = useToast();
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

  // ── meetings (no view permission → the whole meetings UI stays hidden) ──
  const access = useMeetingsAccess();
  const meetingsQ = useMeetingsQuery(access.canView);
  const targetsQ = useMeetingTargetsQuery(access.canView);
  const targets = useMemo(() => targetsQ.data?.items ?? [], [targetsQ.data]);
  const { create, update, remove, sync } = useMeetingMutations(targets);
  const [chosenTargets, setChosenTargets] = useState<string[] | null>(null);
  const visibleIds = useMemo(
    () => chosenTargets ?? (targetsQ.data ? loadVisibleTargets(targetsQ.data.items) : null),
    [chosenTargets, targetsQ.data],
  );
  const visible = useMemo(() => new Set(visibleIds ?? []), [visibleIds]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<meeting.Meeting | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingOccurrence | null>(null);
  const account = meetingsQ.data?.account ?? null;
  const accountReady = !!account?.email && account.calendarReady;

  const tasks = data ?? [];
  const { byDay, undated } = useMemo(() => groupTasksByDay(tasks), [tasks]);
  const today = todayUtc();
  const cells = useMemo(
    () => (view === "month" ? buildMonthGrid(anchor, today) : buildWeekGrid(anchor, today)),
    // today is stable within a render; anchor/view drive the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, anchor],
  );
  const meetingsByDay = useMemo(() => {
    const items = meetingsQ.data?.items ?? [];
    // Targets unavailable (error) → show every meeting rather than hide them all.
    const shown = visibleIds ? items.filter((m) => visible.has(m.targetId)) : items;
    return groupOccurrencesByDay(shown, cells[0]!.key, cells[cells.length - 1]!.key);
  }, [meetingsQ.data, visibleIds, visible, cells]);

  const goPrev = () => setAnchor((a) => (view === "month" ? addMonths(a, -1) : addDays(startOfWeek(a), -7)));
  const goNext = () => setAnchor((a) => (view === "month" ? addMonths(a, 1) : addDays(startOfWeek(a), 7)));
  const goToday = () => setAnchor(todayUtc());

  const rangeLabel = view === "month" ? formatMonthLabel(startOfMonth(anchor)) : weekRangeLabel(anchor);
  const loading = isPending || (access.canView && meetingsQ.isPending);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const submitMeeting = (body: meeting.CreateMeetingRequest) => {
    setFormOpen(false);
    if (editing) {
      update.mutate({ id: editing.id, body }, { onSuccess: () => toast.show({ kind: "success", title: "ミーティングを更新しました" }) });
    } else {
      create.mutate(body, {
        onSuccess: (m) => toast.show({ kind: "success", title: "ミーティングを登録しました", description: `Meet を発行し、${m.attendeeCount}人を招待しました` }),
      });
    }
    setEditing(null);
  };

  const driveSettingsLink = (
    <Button variant="secondary" size="sm" onClick={() => window.location.assign(DRIVE_SETTINGS_URL)} testId="calendar-meetings-open-drive-settings">
      Drive共有 の設定を開く
    </Button>
  );

  const content = loading ? (
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
      <CalendarGrid
        cells={cells}
        byDay={byDay}
        onSelectTask={setSelected}
        meetingsByDay={meetingsByDay}
        onSelectMeeting={setSelectedMeeting}
        week={view === "week"}
      />

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
  );

  const main = (
    <div className={styles.main}>
      {access.canView && account && !account.email ? (
        <div className={styles.banner} role="status" data-testid="calendar-meetings-no-account">
          <span>共有 Google アカウントが未接続です（Drive共有 &gt; 設定）</span>
          {driveSettingsLink}
        </div>
      ) : access.canView && account && !account.calendarReady ? (
        <div className={styles.banner} role="status" data-testid="calendar-meetings-reconnect">
          <span>カレンダー権限がありません。Drive共有 &gt; 設定 で再接続してください</span>
          {driveSettingsLink}
        </div>
      ) : null}
      {access.canView && meetingsQ.isError ? (
        <div role="alert" data-testid="calendar-meetings-error" className="fe2-inline-error">
          <p>ミーティングを取得できませんでした。</p>
          <Button variant="secondary" size="sm" onClick={() => meetingsQ.refetch()}>
            再試行
          </Button>
        </div>
      ) : null}

      <div className={styles.legend} data-testid="calendar-legend">
        {access.canView ? (
          <span className={styles.legendItem} style={{ color: "var(--dub-color-info-700)" }}>
            <VideoGlyph />
            ミーティング
          </span>
        ) : null}
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

      {content}
    </div>
  );

  return (
    <main data-testid="fe2-calendar" className="fe2-page">
      <PageHeader
        testId="fe2-calendar-header"
        title="カレンダー"
        description="マイタスク・ガントと同じタスクを、期限や期間でカレンダーに表示します"
        actions={
          access.canEdit ? (
            <div className={styles.headerActions} data-feature={MEETINGS_FEATURE_MARKER} data-testid="calendar-meetings-toolbar">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => sync.mutate()}
                loading={sync.isPending}
                disabled={!accountReady}
                testId="calendar-meetings-sync"
              >
                招待を今すぐ同期
              </Button>
              <Button
                variant="primary"
                iconLeft={<Icon name="plus" />}
                onClick={openCreate}
                disabled={!accountReady}
                testId="calendar-meetings-create"
              >
                定例ミーティングを設定
              </Button>
            </div>
          ) : undefined
        }
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

        {access.canView ? (
          <div className={styles.layout} data-feature={MEETINGS_FEATURE_MARKER}>
            <MeetingFilter
              targets={targets}
              visible={visible}
              loading={targetsQ.isPending}
              onChange={(ids) => {
                setChosenTargets(ids);
                saveVisibleTargets(ids);
              }}
            />
            {main}
          </div>
        ) : (
          main
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

      {access.canView ? (
        <MeetingDetailDialog
          occurrence={selectedMeeting}
          canEdit={access.canEdit}
          onClose={() => setSelectedMeeting(null)}
          onEdit={(m) => {
            setSelectedMeeting(null);
            setEditing(m);
            setFormOpen(true);
          }}
          onDelete={(m) => {
            setSelectedMeeting(null);
            remove.mutate(m.id, { onSuccess: () => toast.show({ kind: "success", title: "ミーティングを削除しました" }) });
          }}
        />
      ) : null}

      {access.canEdit ? (
        <MeetingFormDialog
          open={formOpen}
          editing={editing}
          targets={targets}
          accountEmail={account?.email ?? null}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSubmit={submitMeeting}
        />
      ) : null}
    </main>
  );
}
