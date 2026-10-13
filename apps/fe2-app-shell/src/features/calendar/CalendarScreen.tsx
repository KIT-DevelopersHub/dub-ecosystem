// カレンダー — a Google Calendar look-alike over the SAME tasks as マイタスク and the
// ガントチャート. 予定 created here are tasks (startAt〜dueAt, assigned to self) written
// through the canonical task-service API, so they also show up in マイタスク/ガント.
// No new backend: reads GET /api/v1/tasks (self-scoped), writes POST/PATCH/DELETE.
// ミーティング (drive-share-service /meetings) are drawn alongside as their own calendars.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Icon, IconButton, Menu, SkeletonLoader, useMediaQuery, useToast } from "@dub/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { common, meeting, task } from "@dub/types";
import { useCalendarApi, useCalendarCaps, useCalendarCurrentUserId, useCalendarCurrentUserName } from "./CalendarProvider.tsx";
import {
  dayIndexOf,
  dayKeyOf,
  draftFromItem,
  draftForAllDay,
  draftForSlot,
  draftToDates,
  encodeDescription,
  formatRangeTitle,
  isMeetingTask,
  isVacationTask,
  formatRangeTitleShort,
  itemsOnDay,
  labelOf,
  PERSONAL_LABEL,
  shiftAnchor,
  toCalendarItems,
  VACATION_TITLE,
  visibleDays,
  type CalendarItem,
  type CalendarView,
  type EventDraft,
} from "./calendar-model";
import { DayListPanel, DetailPanel, EventDialog, ItemTitleProvider, type AnchorRect } from "./CalendarPanels.tsx";
import { MiniCalendar, MonthGrid, ScheduleList, TimeGrid, type SlotGhost } from "./CalendarViews.tsx";
import { MeetingDetailDialog } from "./MeetingDetailDialog.tsx";
import { MeetingFilter } from "./MeetingFilter.tsx";
import { MeetingFormDialog } from "./MeetingFormDialog.tsx";
import { loadVisibleTargets, saveVisibleTargets } from "./meeting-form";
import { meetingTasks, type MeetingOccurrence } from "./meeting-occurrences";
import { useMeetingMutations, useMeetingTargetsQuery, useMeetingsAccess, useMeetingsQuery } from "./useMeetings.tsx";
import {
  STATUS_ORDER,
  VACATION_VISUAL,
  buildLabels,
  ownedTitle,
  ownerOf,
  resolveLabel,
  statusVisual,
} from "./taskVisuals";
import styles from "./calendar.module.css";

const VIEW_LABEL: Record<CalendarView, string> = { day: "日", week: "週", month: "月", schedule: "スケジュール" };
const VIEW_KEYS: Record<string, CalendarView> = { d: "day", w: "week", m: "month", a: "schedule" };
const UNTITLED = "（タイトルなし）";
/** Sidebar toggle key for 休暇 (the others are task statuses). */
const VACATION_KEY = "vacation" as const;
type CalendarKey = task.TaskStatus | typeof VACATION_KEY;
/** Sidebar checkbox color for ラベル (they filter; event colors stay per status). */
const LABEL_COLOR = "#616161";

/** Liveness marker for the meetings feature (shipped in the bundle; checked by verify:live). */
export const MEETINGS_FEATURE_MARKER = "cal-meet-v1";

/** Opens Drive共有 > 設定 on load (driveshare/DriveShareSettings settingsOpenOnLoad). */
const DRIVE_SETTINGS_URL = "/driveshare?setting=google-account";

type Panel =
  | { kind: "create"; draft: EventDraft; ghost: SlotGhost | null }
  | { kind: "edit"; item: CalendarItem; draft: EventDraft }
  | { kind: "detail"; item: CalendarItem; anchor: AnchorRect | null }
  | { kind: "day"; day: number; anchor: AnchorRect | null };

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** An hour starting at the next whole hour, on `day` (the 作成 button / "c"). */
function nextHourDraft(day: number): EventDraft {
  const h = Math.min(23, new Date().getHours() + 1);
  return draftForSlot(day, h * 60, (h + 1) * 60);
}

function taskPath(t: task.Task): string {
  return t.eventId ? `/events/${t.eventId}/tasks/${t.id}` : "/me/tasks";
}

export function CalendarScreen(): JSX.Element {
  const api = useCalendarApi();
  const currentUserId = useCalendarCurrentUserId();
  const currentUserName = useCalendarCurrentUserName();
  const { canWrite, canDelete } = useCalendarCaps();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const narrow = useMediaQuery("(max-width: 900px)");

  const today = dayIndexOf(new Date());
  // Phones open on 日 (seven columns don't fit), desktop on 週 — Google's defaults.
  const [view, setView] = useState<CalendarView>(() => (narrow ? "day" : "week"));
  const [anchorDay, setAnchorDay] = useState(today);
  const [hidden, setHidden] = useState<ReadonlySet<CalendarKey>>(() => new Set());
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlySet<string>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [panel, setPanel] = useState<Panel | null>(null);
  useEffect(() => setSidebarOpen(!narrow), [narrow]);
  const days = visibleDays(view, anchorDay);

  // ── meetings (no view permission → the whole meetings UI stays hidden) ──
  const access = useMeetingsAccess();
  const meetingsQ = useMeetingsQuery(access.canView);
  const targetsQ = useMeetingTargetsQuery(access.canView);
  const targets = useMemo(() => targetsQ.data?.items ?? [], [targetsQ.data]);
  const { create: createMeeting, update: updateMeeting, remove: removeMeeting, sync } = useMeetingMutations(targets);
  const [chosenTargets, setChosenTargets] = useState<string[] | null>(null);
  // Default = the calendars I belong to (+ 全体); a manual choice is remembered per browser.
  const visibleIds = useMemo(
    () => chosenTargets ?? (targetsQ.data ? loadVisibleTargets(targetsQ.data.items) : null),
    [chosenTargets, targetsQ.data],
  );
  const [meetingForm, setMeetingForm] = useState<{ editing: meeting.Meeting | null } | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingOccurrence | null>(null);
  const account = meetingsQ.data?.account ?? null;
  const accountReady = !!account?.email && account.calendarReady;
  const firstKey = dayKeyOf(days[0]!);
  const lastKey = dayKeyOf(days[days.length - 1]!);
  const meetingOcc = useMemo(() => {
    const all = meetingsQ.data?.items ?? [];
    // Targets unavailable (error) → show every meeting rather than hide them all.
    const shown = visibleIds ? all.filter((m) => visibleIds.includes(m.targetId)) : all;
    return meetingTasks(shown, firstKey, lastKey);
  }, [meetingsQ.data, visibleIds, firstKey, lastKey]);

  // Scope to the caller's own tasks (担当/依頼) — task-service's "/me rule" rejects a
  // bare list. `enabled` waits for the session so no unscoped request is fired.
  const queryKey = useMemo(() => ["calendar", "tasks", currentUserId] as const, [currentUserId]);
  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => api.listMyTasks(currentUserId as common.UserId),
    enabled: currentUserId != null,
  });

  // ラベル = 個人 + every org role, so a role added in ロール管理 appears here by itself.
  // Without identity:read (or on failure) only 個人 is offered.
  const rolesQuery = useQuery({ queryKey: ["calendar", "roles"], queryFn: () => api.listRoles(), staleTime: 5 * 60_000 });
  const labels = useMemo(() => buildLabels(rolesQuery.data ?? []), [rolesQuery.data]);
  const labelKeyOf = useCallback((t: task.Task) => resolveLabel(labels, labelOf(t)).key, [labels]);

  // 個人 予定 lead with the person's name ("山田：休暇"), labelled ones with the role.
  // Names need identity:read; without it only the signed-in user's own name is known.
  const personIds = useMemo(() => {
    const ids = new Set<common.UserId>();
    for (const t of data ?? []) {
      const p = t.assigneeId ?? t.createdBy;
      if (p) ids.add(p);
    }
    return [...ids].sort();
  }, [data]);
  const usersQuery = useQuery({
    queryKey: ["calendar", "users", personIds],
    queryFn: () => api.getUsers(personIds),
    enabled: personIds.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (currentUserId && currentUserName) m.set(currentUserId, currentUserName);
    for (const u of usersQuery.data ?? []) m.set(u.id, u.displayName);
    return m;
  }, [currentUserId, currentUserName, usersQuery.data]);
  const itemTitle = useCallback(
    (t: task.Task) =>
      ownedTitle(t, isMeetingTask(t) ? (meetingOcc.byId.get(t.id)?.meeting.targetName ?? null) : ownerOf(t, labels, names)),
    [labels, names, meetingOcc],
  );
  const detailLabelName = (t: task.Task) => {
    const label = resolveLabel(labels, labelOf(t));
    const owner = ownerOf(t, labels, names);
    return label.key === PERSONAL_LABEL && owner ? `${label.name}（${owner}）` : label.name;
  };

  const { items, undated } = useMemo(() => {
    // 休暇 is its own calendar in the sidebar; everything else toggles by status.
    const shown = (t: task.Task) =>
      !hidden.has(isVacationTask(t) ? VACATION_KEY : t.status) && !hiddenLabels.has(labelKeyOf(t));
    const all = toCalendarItems(data ?? []);
    const meetings = toCalendarItems(meetingOcc.tasks).items;
    return { items: [...all.items.filter((it) => shown(it.task)), ...meetings], undated: all.undated.filter(shown) };
  }, [data, hidden, hiddenLabels, labelKeyOf, meetingOcc]);

  // ── mutations (optimistic: reflect first, roll back on failure) ──────────
  const snapshot = async () => {
    await qc.cancelQueries({ queryKey });
    return qc.getQueryData<task.Task[]>(queryKey);
  };
  const rollback = (prev: task.Task[] | undefined, title: string) => {
    qc.setQueryData(queryKey, prev);
    toast.show({ kind: "error", title });
  };
  const settle = () => void qc.invalidateQueries({ queryKey });
  const fields = (draft: EventDraft) => ({
    title: draft.title.trim() || (draft.kind === "vacation" ? VACATION_TITLE : UNTITLED),
    description: encodeDescription(draft),
    ...draftToDates(draft),
  });

  const createMut = useMutation({
    mutationFn: (draft: EventDraft) => {
      const f = fields(draft);
      return api.createTask({
        title: f.title,
        startAt: f.startAt,
        dueAt: f.dueAt,
        ...(f.description ? { description: f.description } : {}),
        ...(currentUserId ? { assigneeId: currentUserId } : {}),
      });
    },
    onMutate: async (draft) => {
      const prev = await snapshot();
      const now = new Date().toISOString();
      const temp: task.Task = {
        id: `tmp_${Date.now()}` as common.TaskId,
        version: 0,
        status: "todo",
        priority: "medium",
        assigneeId: currentUserId,
        origin: "internal",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        ...fields(draft),
      };
      qc.setQueryData<task.Task[]>(queryKey, (old) => [...(old ?? []), temp]);
      return { prev, tempId: temp.id };
    },
    onError: (_e, _d, ctx) => rollback(ctx?.prev, "予定を保存できませんでした"),
    onSuccess: (created, draft, ctx) => {
      qc.setQueryData<task.Task[]>(queryKey, (old) => (old ?? []).map((t) => (t.id === ctx?.tempId ? created : t)));
      toast.show({ kind: "success", title: draft.kind === "vacation" ? "休暇を登録しました" : "予定を保存しました" });
    },
    onSettled: settle,
  });

  const updateMut = useMutation({
    mutationFn: ({ item, draft }: { item: CalendarItem; draft: EventDraft }) =>
      api.updateTask(item.task.id, { version: item.task.version, ...fields(draft) }),
    onMutate: async ({ item, draft }) => {
      const prev = await snapshot();
      qc.setQueryData<task.Task[]>(queryKey, (old) =>
        (old ?? []).map((t) => (t.id === item.task.id ? { ...t, ...fields(draft) } : t)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => rollback(ctx?.prev, "予定を更新できませんでした"),
    onSuccess: (updated) => {
      qc.setQueryData<task.Task[]>(queryKey, (old) => (old ?? []).map((t) => (t.id === updated.id ? updated : t)));
      toast.show({ kind: "success", title: "予定を更新しました" });
    },
    onSettled: settle,
  });

  const deleteMut = useMutation({
    mutationFn: (item: CalendarItem) => api.deleteTask(item.task.id),
    onMutate: async (item) => {
      const prev = await snapshot();
      qc.setQueryData<task.Task[]>(queryKey, (old) => (old ?? []).filter((t) => t.id !== item.task.id));
      return { prev };
    },
    onError: (_e, _v, ctx) => rollback(ctx?.prev, "予定を削除できませんでした"),
    onSuccess: () => toast.show({ kind: "success", title: "予定を削除しました" }),
    onSettled: settle,
  });

  // ── navigation / panels ──────────────────────────────────────────────────
  const close = useCallback(() => setPanel(null), []);
  const openDay = (day: number) => {
    setPanel(null);
    setAnchorDay(day);
    setView("day");
  };
  const openCreate = (draft: EventDraft, ghost: SlotGhost | null = null) => {
    if (canWrite) setPanel({ kind: "create", draft, ghost });
  };
  const openCreateDialog = () => openCreate(nextHourDraft(anchorDay));
  const selectItem = (item: CalendarItem, anchor: AnchorRect) => {
    if (isMeetingTask(item.task)) {
      setPanel(null);
      setSelectedMeeting(meetingOcc.byId.get(item.task.id) ?? null);
    } else setPanel({ kind: "detail", item, anchor });
  };
  const submitMeeting = (body: meeting.CreateMeetingRequest) => {
    const editing = meetingForm?.editing ?? null;
    setMeetingForm(null);
    if (editing) {
      updateMeeting.mutate({ id: editing.id, body }, { onSuccess: () => toast.show({ kind: "success", title: "ミーティングを更新しました" }) });
    } else {
      createMeeting.mutate(body, {
        onSuccess: (m) => toast.show({ kind: "success", title: "ミーティングを登録しました", description: `Meet を発行し、${m.attendeeCount}人を招待しました` }),
      });
    }
  };

  // Google's single-key shortcuts: t 今日 / j,n 次 / k,p 前 / d w m a 表示 / c 作成.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || panel || meetingForm || selectedMeeting) return;
      const k = e.key.toLowerCase();
      if (k === "t") setAnchorDay(today);
      else if (k === "j" || k === "n") setAnchorDay((a) => shiftAnchor(view, a, 1));
      else if (k === "k" || k === "p") setAnchorDay((a) => shiftAnchor(view, a, -1));
      else if (VIEW_KEYS[k]) setView(VIEW_KEYS[k]!);
      else if (k === "c" && canWrite) {
        e.preventDefault();
        openCreate(nextHourDraft(anchorDay));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, view, today, anchorDay, canWrite, meetingForm, selectedMeeting]);

  const meetingNotice = !access.canView ? null : meetingsQ.isError ? (
    <div className={styles.meetingNotice} role="alert" data-testid="calendar-meetings-error">
      ミーティングを取得できませんでした。
      <Button variant="secondary" size="sm" onClick={() => meetingsQ.refetch()}>
        再試行
      </Button>
    </div>
  ) : account && !accountReady ? (
    <div
      className={styles.meetingNotice}
      role="status"
      data-testid={account.email ? "calendar-meetings-reconnect" : "calendar-meetings-no-account"}
    >
      {account.email
        ? "共有 Google アカウントにカレンダー権限がありません。Drive共有 > 設定 で再接続してください。"
        : "共有 Google アカウントが未接続です（Drive共有 > 設定）。"}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => window.location.assign(DRIVE_SETTINGS_URL)}
        testId="calendar-meetings-open-drive-settings"
      >
        Drive共有 の設定を開く
      </Button>
    </div>
  ) : null;

  let body: JSX.Element;
  if (isPending) {
    body = (
      <div className={`${styles.main} ${styles.overlayMsg}`} data-testid="calendar-loading">
        <SkeletonLoader lines={10} />
      </div>
    );
  } else if (isError) {
    body = (
      <div className={`${styles.main} ${styles.overlayMsg}`}>
        <div role="alert" data-testid="calendar-error" className="fe2-inline-error">
          <p>予定を取得できませんでした。</p>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            再試行
          </Button>
        </div>
      </div>
    );
  } else if (view === "month") {
    body = (
      <MonthGrid
        anchorDay={anchorDay}
        today={today}
        items={items}
        canCreate={canWrite}
        onCreateAllDay={(d) => openCreate(draftForAllDay(d))}
        onSelectItem={selectItem}
        onMore={(day, anchor) => setPanel({ kind: "day", day, anchor })}
        onOpenDay={openDay}
      />
    );
  } else if (view === "schedule") {
    body = <ScheduleList days={days} today={today} items={items} onSelectItem={selectItem} onOpenDay={openDay} />;
  } else {
    body = (
      <TimeGrid
        days={days}
        today={today}
        items={items}
        ghost={panel?.kind === "create" ? panel.ghost : null}
        canCreate={canWrite}
        onCreateTimed={(d, s, e) => openCreate(draftForSlot(d, s, e), { day: d, startMin: s, endMin: e })}
        onCreateAllDay={(d) => openCreate(draftForAllDay(d))}
        onSelectItem={selectItem}
        onOpenDay={openDay}
      />
    );
  }

  return (
    <ItemTitleProvider value={itemTitle}>
      <div className={styles.app} data-app-bleed data-testid="fe2-calendar">
        <header className={styles.topbar}>
          <IconButton
            name="menu"
            aria-label="メインメニュー"
            onClick={() => setSidebarOpen((o) => !o)}
            testId="calendar-menu"
          />
          <h1 className={styles.brand}>
            <span className={styles.brandIcon} aria-hidden="true">
              <Icon name="calendar" />
            </span>
            <span className={styles.brandText}>カレンダー</span>
          </h1>
          <Button variant="secondary" size="sm" onClick={() => setAnchorDay(today)} testId="calendar-today">
            今日
          </Button>
          <span className={styles.flip}>
            <IconButton
              name="chevron-right"
              aria-label={`前の${VIEW_LABEL[view]}`}
              onClick={() => setAnchorDay((a) => shiftAnchor(view, a, -1))}
              testId="calendar-prev"
            />
          </span>
          <IconButton
            name="chevron-right"
            aria-label={`次の${VIEW_LABEL[view]}`}
            onClick={() => setAnchorDay((a) => shiftAnchor(view, a, 1))}
            testId="calendar-next"
          />
          <span className={styles.rangeTitle} data-testid="calendar-range-label">
            {narrow ? formatRangeTitleShort(view, anchorDay) : formatRangeTitle(view, anchorDay)}
          </span>
          <span className={styles.spacer} />
          {narrow && canWrite && (
            <IconButton
              name="plus"
              variant="primary"
              aria-label="予定を作成"
              onClick={openCreateDialog}
              testId="calendar-create-mini"
            />
          )}
          <Menu
            label={VIEW_LABEL[view]}
            variant="secondary"
            menuLabel="表示切替"
            testId="calendar-view-menu"
            items={(Object.keys(VIEW_LABEL) as CalendarView[]).map((v) => ({
              id: v,
              label: VIEW_LABEL[v],
              onSelect: () => setView(v),
              testId: `calendar-view-${v}`,
            }))}
          />
        </header>

        <div className={styles.body}>
          {sidebarOpen && (
            <aside className={styles.sidebar} data-testid="calendar-sidebar">
              <div className={styles.createRow} data-testid="calendar-create-row">
                <Button
                  iconLeft={<Icon name="plus" />}
                  onClick={openCreateDialog}
                  disabled={!canWrite}
                  testId="calendar-create"
                >
                  作成
                </Button>
              </div>

              {access.canEdit && (
                <div className={styles.meetingActions} data-feature={MEETINGS_FEATURE_MARKER} data-testid="calendar-meetings-toolbar">
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<Icon name="plus" />}
                    onClick={() => setMeetingForm({ editing: null })}
                    disabled={!accountReady}
                    testId="calendar-meetings-create"
                  >
                    ミーティングを設定
                  </Button>
                </div>
              )}

              <MiniCalendar
                selectedDay={anchorDay}
                today={today}
                onSelect={(d) => {
                  setAnchorDay(d);
                  if (narrow) setSidebarOpen(false);
                }}
              />

              <div data-testid="calendar-list">
                <div className={styles.calListHead}>マイカレンダー</div>
                {[...STATUS_ORDER, VACATION_KEY as CalendarKey].map((s) => {
                  const v = s === VACATION_KEY ? VACATION_VISUAL : statusVisual(s);
                  return (
                    <label key={s} className={styles.calItem}>
                      <input
                        type="checkbox"
                        className={styles.calCheck}
                        style={{ ["--cal-color" as string]: v.color }}
                        checked={!hidden.has(s)}
                        onChange={() =>
                          setHidden((prev) => {
                            const next = new Set(prev);
                            if (next.has(s)) next.delete(s);
                            else next.add(s);
                            return next;
                          })
                        }
                        data-testid={`calendar-filter-${s}`}
                      />
                      {v.label}
                    </label>
                  );
                })}
              </div>

              <div data-testid="calendar-label-list">
                <div className={styles.calListHead}>ラベル</div>
                {rolesQuery.isPending ? (
                  <SkeletonLoader lines={3} />
                ) : (
                  labels.map((l) => (
                    <label key={l.key} className={styles.calItem}>
                      <input
                        type="checkbox"
                        className={styles.calCheck}
                        style={{ ["--cal-color" as string]: LABEL_COLOR }}
                        checked={!hiddenLabels.has(l.key)}
                        onChange={() =>
                          setHiddenLabels((prev) => {
                            const next = new Set(prev);
                            if (next.has(l.key)) next.delete(l.key);
                            else next.add(l.key);
                            return next;
                          })
                        }
                        data-testid={`calendar-label-filter-${l.key}`}
                      />
                      {l.name}
                    </label>
                  ))
                )}
              </div>

              {access.canView && (
                <MeetingFilter
                  targets={targets}
                  visible={new Set(visibleIds ?? [])}
                  loading={targetsQ.isPending}
                  notice={meetingNotice}
                  headAction={
                    access.canEdit && accountReady ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => sync.mutate()}
                        loading={sync.isPending}
                        testId="calendar-meetings-sync"
                      >
                        招待を同期
                      </Button>
                    ) : null
                  }
                  onChange={(ids) => {
                    setChosenTargets(ids);
                    saveVisibleTargets(ids);
                  }}
                />
              )}

              {undated.length > 0 && (
                <div className={styles.undated} data-testid="calendar-undated">
                  <div className={styles.calListHead}>日付未設定（{undated.length}件）</div>
                  {undated.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={styles.undatedItem}
                      onClick={() => void navigate({ to: taskPath(t) })}
                      data-testid={`calendar-undated-${t.id}`}
                    >
                      <span className={styles.dot} style={{ background: statusVisual(t.status).color }} />
                      {t.title}
                    </button>
                  ))}
                </div>
              )}

              <p className={styles.sideNote}>
                予定はマイタスクのタスクとして保存され、マイタスク・ガントにも表示されます。
                {access.canView && " ミーティングは共有 Google アカウントのカレンダーに登録され、対象ロールのメンバーへ招待が届きます。"}
              </p>
            </aside>
          )}
          {body}
        </div>

        {panel?.kind === "create" && (
          <EventDialog
            editing={false}
            draft={panel.draft}
            labels={labels}
            onChange={(draft) => setPanel({ ...panel, draft })}
            onSave={() => {
              setPanel(null);
              createMut.mutate(panel.draft);
            }}
            onClose={close}
            saving={createMut.isPending}
          />
        )}

        {panel?.kind === "detail" && (
          <DetailPanel
            anchor={panel.anchor}
            item={panel.item}
            labelName={detailLabelName(panel.item.task)}
            // An optimistic row has no server id yet — nothing to edit/delete until it lands.
            canWrite={canWrite && !panel.item.task.id.startsWith("tmp_")}
            canDelete={canDelete && !panel.item.task.id.startsWith("tmp_")}
            onClose={close}
            onEdit={() => setPanel({ kind: "edit", item: panel.item, draft: draftFromItem(panel.item) })}
            onDelete={() => {
              setPanel(null);
              deleteMut.mutate(panel.item);
            }}
            onOpenInTasks={() => {
              setPanel(null);
              void navigate({ to: taskPath(panel.item.task) });
            }}
          />
        )}

        {panel?.kind === "day" && (
          <DayListPanel
            anchor={panel.anchor}
            day={panel.day}
            items={itemsOnDay(items, panel.day)}
            onClose={close}
            onSelect={selectItem}
            onOpenDay={() => openDay(panel.day)}
          />
        )}

        {panel?.kind === "edit" && (
          <EventDialog
            editing
            draft={panel.draft}
            labels={labels}
            onChange={(draft) => setPanel({ ...panel, draft })}
            onSave={() => {
              setPanel(null);
              updateMut.mutate({ item: panel.item, draft: panel.draft });
            }}
            onClose={close}
            saving={updateMut.isPending}
          />
        )}

        {access.canView && (
          <MeetingDetailDialog
            occurrence={selectedMeeting}
            canEdit={access.canEdit}
            onClose={() => setSelectedMeeting(null)}
            onEdit={(m) => {
              setSelectedMeeting(null);
              setMeetingForm({ editing: m });
            }}
            onDelete={(m) => {
              setSelectedMeeting(null);
              removeMeeting.mutate(m.id, { onSuccess: () => toast.show({ kind: "success", title: "ミーティングを削除しました" }) });
            }}
          />
        )}

        {access.canEdit && (
          <MeetingFormDialog
            open={meetingForm != null}
            editing={meetingForm?.editing ?? null}
            targets={targets}
            accountEmail={account?.email ?? null}
            onClose={() => setMeetingForm(null)}
            onSubmit={submitMeeting}
          />
        )}
      </div>
    </ItemTitleProvider>
  );
}
