// カレンダー — a Google Calendar look-alike over the SAME tasks as マイタスク and the
// ガントチャート. 予定 created here are tasks (startAt〜dueAt, assigned to self) written
// through the canonical task-service API, so they also show up in マイタスク/ガント.
// No new backend: reads GET /api/v1/tasks (self-scoped), writes POST/PATCH/DELETE.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Icon, Menu, Modal, SkeletonLoader, useMediaQuery, useToast } from "@dub/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { common, task } from "@dub/types";
import { useCalendarApi, useCalendarCaps, useCalendarCurrentUserId } from "./CalendarProvider.tsx";
import {
  dayIndexOf,
  draftFromItem,
  draftForAllDay,
  draftForSlot,
  draftToDates,
  formatRangeTitle,
  itemsOnDay,
  shiftAnchor,
  toCalendarItems,
  visibleDays,
  type CalendarItem,
  type CalendarView,
  type EventDraft,
} from "./calendar-model";
import { CreatePanel, DayListPanel, DetailPanel, EventForm, type AnchorRect } from "./CalendarPanels.tsx";
import { MiniCalendar, MonthGrid, ScheduleList, TimeGrid, type SlotGhost } from "./CalendarViews.tsx";
import { STATUS_ORDER, statusVisual } from "./taskVisuals";
import styles from "./calendar.module.css";

const VIEW_LABEL: Record<CalendarView, string> = { day: "日", week: "週", month: "月", schedule: "スケジュール" };
const VIEW_KEYS: Record<string, CalendarView> = { d: "day", w: "week", m: "month", a: "schedule" };
const UNTITLED = "（タイトルなし）";

type Panel =
  | { kind: "create"; draft: EventDraft; anchor: AnchorRect | null; ghost: SlotGhost | null }
  | { kind: "edit"; item: CalendarItem | null; draft: EventDraft }
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
  const { canWrite, canDelete } = useCalendarCaps();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const narrow = useMediaQuery("(max-width: 900px)");

  const today = dayIndexOf(new Date());
  const [view, setView] = useState<CalendarView>("week");
  const [anchorDay, setAnchorDay] = useState(today);
  const [hidden, setHidden] = useState<ReadonlySet<task.TaskStatus>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [panel, setPanel] = useState<Panel | null>(null);
  useEffect(() => setSidebarOpen(!narrow), [narrow]);

  // Scope to the caller's own tasks (担当/依頼) — task-service's "/me rule" rejects a
  // bare list. `enabled` waits for the session so no unscoped request is fired.
  const queryKey = useMemo(() => ["calendar", "tasks", currentUserId] as const, [currentUserId]);
  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => api.listMyTasks(currentUserId as common.UserId),
    enabled: currentUserId != null,
  });

  const { items, undated } = useMemo(() => {
    const all = toCalendarItems(data ?? []);
    return {
      items: all.items.filter((it) => !hidden.has(it.task.status)),
      undated: all.undated.filter((t) => !hidden.has(t.status)),
    };
  }, [data, hidden]);

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
    title: draft.title.trim() || UNTITLED,
    description: draft.description.trim() || null,
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
    onSuccess: (created, _d, ctx) => {
      qc.setQueryData<task.Task[]>(queryKey, (old) => (old ?? []).map((t) => (t.id === ctx?.tempId ? created : t)));
      toast.show({ kind: "success", title: "予定を保存しました" });
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
  const openCreate = (draft: EventDraft, anchor: AnchorRect | null, ghost: SlotGhost | null = null) => {
    if (canWrite) setPanel({ kind: "create", draft, anchor, ghost });
  };
  const openCreateDialog = () => {
    if (canWrite) setPanel({ kind: "edit", item: null, draft: nextHourDraft(anchorDay) });
  };
  const selectItem = (item: CalendarItem, anchor: AnchorRect) => setPanel({ kind: "detail", item, anchor });

  // Google's single-key shortcuts: t 今日 / j,n 次 / k,p 前 / d w m a 表示 / c 作成.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || panel) return;
      const k = e.key.toLowerCase();
      if (k === "t") setAnchorDay(today);
      else if (k === "j" || k === "n") setAnchorDay((a) => shiftAnchor(view, a, 1));
      else if (k === "k" || k === "p") setAnchorDay((a) => shiftAnchor(view, a, -1));
      else if (VIEW_KEYS[k]) setView(VIEW_KEYS[k]!);
      else if (k === "c" && canWrite) {
        e.preventDefault();
        setPanel({ kind: "edit", item: null, draft: nextHourDraft(anchorDay) });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, view, today, anchorDay, canWrite]);

  const days = visibleDays(view, anchorDay);

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
        onCreateAllDay={(d, a) => openCreate(draftForAllDay(d), a)}
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
        onCreateTimed={(d, s, e, a) => openCreate(draftForSlot(d, s, e), a, { day: d, startMin: s, endMin: e })}
        onCreateAllDay={(d, a) => openCreate(draftForAllDay(d), a)}
        onSelectItem={selectItem}
        onOpenDay={openDay}
      />
    );
  }

  return (
    <div className={styles.app} data-app-bleed data-testid="fe2-calendar">
      <header className={styles.topbar}>
        <button
          type="button"
          className={styles.roundBtn}
          aria-label="メインメニュー"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((o) => !o)}
          data-testid="calendar-menu"
        >
          <Icon name="menu" />
        </button>
        <h1 className={styles.brand}>
          <span className={styles.brandIcon} aria-hidden="true">
            <Icon name="calendar" />
          </span>
          <span className={styles.brandText}>カレンダー</span>
        </h1>
        <button type="button" className={styles.todayBtn} onClick={() => setAnchorDay(today)} data-testid="calendar-today">
          今日
        </button>
        <button
          type="button"
          className={styles.roundBtn}
          aria-label={`前の${VIEW_LABEL[view]}`}
          onClick={() => setAnchorDay((a) => shiftAnchor(view, a, -1))}
          data-testid="calendar-prev"
        >
          <span className={styles.flip}>
            <Icon name="chevron-right" />
          </span>
        </button>
        <button
          type="button"
          className={styles.roundBtn}
          aria-label={`次の${VIEW_LABEL[view]}`}
          onClick={() => setAnchorDay((a) => shiftAnchor(view, a, 1))}
          data-testid="calendar-next"
        >
          <Icon name="chevron-right" />
        </button>
        <span className={styles.rangeTitle} data-testid="calendar-range-label">
          {formatRangeTitle(view, anchorDay)}
        </span>
        <span className={styles.spacer} />
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
            <button
              type="button"
              className={styles.createBtn}
              onClick={openCreateDialog}
              disabled={!canWrite}
              title={canWrite ? "予定を作成" : "予定を作成する権限がありません"}
              data-testid="calendar-create"
            >
              <span className={styles.createPlus} aria-hidden="true">
                +
              </span>
              作成
            </button>

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
              {STATUS_ORDER.map((s) => {
                const v = statusVisual(s);
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

            <p className={styles.sideNote}>予定はマイタスクのタスクとして保存され、マイタスク・ガントにも表示されます。</p>
          </aside>
        )}
        {body}
      </div>

      {panel?.kind === "create" && (
        <CreatePanel
          anchor={panel.anchor}
          draft={panel.draft}
          onChange={(draft) => setPanel({ ...panel, draft })}
          onSave={() => {
            setPanel(null);
            createMut.mutate(panel.draft);
          }}
          onClose={close}
          onMoreOptions={() => setPanel({ kind: "edit", item: null, draft: panel.draft })}
          saving={createMut.isPending}
        />
      )}

      {panel?.kind === "detail" && (
        <DetailPanel
          anchor={panel.anchor}
          item={panel.item}
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
        <Modal open onClose={close} title={panel.item ? "予定を編集" : "予定を作成"} size="md" testId="calendar-edit-dialog">
          <EventForm
            draft={panel.draft}
            onChange={(draft) => setPanel({ ...panel, draft })}
            onCancel={close}
            saving={createMut.isPending || updateMut.isPending}
            onSubmit={() => {
              setPanel(null);
              if (panel.item) updateMut.mutate({ item: panel.item, draft: panel.draft });
              else createMut.mutate(panel.draft);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
