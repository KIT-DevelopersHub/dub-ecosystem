// カレンダー — a Google Calendar look-alike over the SAME tasks as マイタスク and the
// ガントチャート. 予定 created here are tasks (startAt〜dueAt, assigned to self) written
// through the canonical task-service API, so they also show up in マイタスク/ガント.
// No new backend: reads GET /api/v1/tasks (self-scoped), writes POST/PATCH/DELETE.
// ミーティング (drive-share-service /meetings) are drawn alongside as their own calendars.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Icon, IconButton, Menu, SkeletonLoader, useMediaQuery, useToast } from "@dub/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { common, identity, meeting, task } from "@dub/types";
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
  formatRangeTitleShort,
  isScheduleTask,
  itemsOnDay,
  ITEM_KINDS,
  kindOf,
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
import {
  AddTeamPicker,
  FilterCheck,
  FilterGroup,
  PeopleSearch,
  RemoveTeamButton,
  useOpenSections,
  type FilterRow,
} from "./CalendarFilters.tsx";
import { DayListPanel, DetailPanel, EventDialog, ItemTitleProvider, type AnchorRect } from "./CalendarPanels.tsx";
import { MiniCalendar, MonthGrid, ScheduleList, TimeGrid, type SlotGhost } from "./CalendarViews.tsx";
import { MeetingDetailDialog } from "./MeetingDetailDialog.tsx";
import { MeetingFilter } from "./MeetingFilter.tsx";
import { MeetingFormDialog } from "./MeetingFormDialog.tsx";
import { useUserPref } from "./calendar-prefs";
import { isMeetingTargetVisible, parseMeetingTargetChoices, type MeetingTargetChoices } from "./meeting-form";
import { meetingTasks, type MeetingOccurrence } from "./meeting-occurrences";
import { useMeetingMutations, useMeetingTargetsQuery, useMeetingsAccess, useMeetingsQuery } from "./useMeetings.tsx";
import {
  KIND_VISUALS,
  STATUS_ORDER,
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
/** Sidebar checkbox color for ラベル / チーム without a color (they filter, not paint). */
const LABEL_COLOR = "#616161";
// Sidebar filter keys. Each names one checkbox; a key in `hidden` hides what it covers.
const SCHEDULE_GROUP = "group:schedule";
const TASK_GROUP = "group:task";
const kindKey = (k: string) => `kind:${k}`;
const labelKey = (k: string) => `label:${k}`;
const statusKey = (s: string) => `status:${s}`;
const scopeKey = (teamId: string | null | undefined) => `scope:${teamId ?? PERSONAL_LABEL}`;
const personKey = (userId: string) => `person:${userId}`;
const HIDDEN_PREF = "hidden";
const MEETING_TARGETS_PREF = "meetingTargets";
const NO_KEYS: readonly string[] = [];
const NO_CHOICES: MeetingTargetChoices = {};
const decodeHidden = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : NO_KEYS;
const WATCHED_TEAMS_STORAGE = "dub.calendar.watchedTeams";
const WATCHED_PEOPLE_STORAGE = "dub.calendar.watchedPeople";

function loadWatchedTeams(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WATCHED_TEAMS_STORAGE) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** ユーザーを検索 で追加した人 (id + name, so the sidebar row renders before any fetch). */
type WatchedPerson = { id: string; name: string };

function loadWatchedPeople(): WatchedPerson[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WATCHED_PEOPLE_STORAGE) ?? "[]");
    return Array.isArray(v)
      ? v.filter((x): x is WatchedPerson => typeof x?.id === "string" && typeof x?.name === "string")
      : [];
  } catch {
    return [];
  }
}

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
  // Unticked sidebar checkboxes, remembered per user across reloads.
  const [hiddenKeys, setHiddenKeys] = useUserPref(HIDDEN_PREF, currentUserId, decodeHidden, NO_KEYS);
  const hidden = useMemo<ReadonlySet<string>>(() => new Set(hiddenKeys), [hiddenKeys]);
  const toggleFilter = useCallback(
    (key: string) => setHiddenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
    [setHiddenKeys],
  );
  const [openSections, toggleSection] = useOpenSections();
  // 他のチーム: teams whose every task is shown, not only the caller's own (kept per browser).
  const [watchedTeams, setWatchedTeams] = useState<string[]>(loadWatchedTeams);
  useEffect(() => {
    try {
      localStorage.setItem(WATCHED_TEAMS_STORAGE, JSON.stringify(watchedTeams));
    } catch {
      /* private mode etc. — the choice just doesn't persist */
    }
  }, [watchedTeams]);
  // ユーザーを検索: people whose 予定・タスク are shown next to the caller's (kept per browser).
  const [watchedPeople, setWatchedPeople] = useState<WatchedPerson[]>(loadWatchedPeople);
  useEffect(() => {
    try {
      localStorage.setItem(WATCHED_PEOPLE_STORAGE, JSON.stringify(watchedPeople));
    } catch {
      /* private mode etc. — the choice just doesn't persist */
    }
  }, [watchedPeople]);
  const watchedPeopleIds = useMemo(() => watchedPeople.map((p) => p.id), [watchedPeople]);
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
  // Default = the calendars I belong to (+ 全体); a manual choice is remembered per user.
  const [targetChoices, setTargetChoices] = useUserPref(MEETING_TARGETS_PREF, currentUserId, parseMeetingTargetChoices, NO_CHOICES);
  const targetState = targetsQ.isError ? "error" : (targetsQ.data?.items ?? null);
  const createdTargets = useMemo(
    () => new Set((meetingsQ.data?.items ?? []).filter((m) => m.createdBy === currentUserId).map((m) => m.targetId)),
    [meetingsQ.data, currentUserId],
  );
  const isTargetVisible = useCallback(
    (id: string) => isMeetingTargetVisible(id, targetChoices, targetState, createdTargets),
    [targetChoices, targetState, createdTargets],
  );
  const [meetingForm, setMeetingForm] = useState<{ editing: meeting.Meeting | null } | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingOccurrence | null>(null);
  const account = meetingsQ.data?.account ?? null;
  const accountReady = !!account?.email && account.calendarReady;
  const firstKey = dayKeyOf(days[0]!);
  const lastKey = dayKeyOf(days[days.length - 1]!);
  const meetingOcc = useMemo(() => {
    const shown = (meetingsQ.data?.items ?? []).filter((m) => isTargetVisible(m.targetId));
    return meetingTasks(shown, firstKey, lastKey);
  }, [meetingsQ.data, isTargetVisible, firstKey, lastKey]);

  // Scope to the caller's own tasks (担当/依頼) — task-service's "/me rule" rejects a
  // bare list — plus every task of the 他のチーム and the people the caller added. One
  // query, so the optimistic writes below touch a single cache entry. `enabled` waits
  // for the session so no unscoped request is fired.
  const queryKey = useMemo(
    () => ["calendar", "tasks", currentUserId, watchedTeams, watchedPeopleIds] as const,
    [currentUserId, watchedTeams, watchedPeopleIds],
  );
  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      // A failing team/person only drops that one; the caller's own 予定 still show.
      const [mine, teams, people] = await Promise.all([
        api.listMyTasks(currentUserId as common.UserId),
        Promise.allSettled(watchedTeams.map((id) => api.listTeamTasks(id as common.TeamId))),
        Promise.allSettled(watchedPeopleIds.map((id) => api.listUserTasks(id as common.UserId))),
      ]);
      if (teams.some((r) => r.status === "rejected")) {
        toast.show({ kind: "error", title: "一部のチームのタスクを取得できませんでした" });
      }
      if (people.some((r) => r.status === "rejected")) {
        toast.show({ kind: "error", title: "一部のユーザーの予定を取得できませんでした" });
      }
      const byId = new Map<common.TaskId, task.Task>();
      for (const t of mine) byId.set(t.id, t);
      for (const r of [...teams, ...people]) if (r.status === "fulfilled") for (const t of r.value) byId.set(t.id, t);
      return [...byId.values()];
    },
    enabled: currentUserId != null,
    placeholderData: keepPreviousData,
  });
  const teamsQuery = useQuery({ queryKey: ["calendar", "teams"], queryFn: () => api.listTeams(), staleTime: 5 * 60_000 });

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
    for (const p of watchedPeople) m.set(p.id, p.name);
    for (const u of usersQuery.data ?? []) m.set(u.id, u.displayName);
    return m;
  }, [currentUserId, currentUserName, watchedPeople, usersQuery.data]);
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
    // 予定 filter by 種類 + ラベル, タスク by 個人/チーム + 状態; each side has a master switch.
    // An added person's checkbox hides everything that is theirs (担当, else 依頼).
    const shown = (t: task.Task) =>
      !hidden.has(personKey(t.assigneeId ?? t.createdBy ?? "")) &&
      (isScheduleTask(t)
        ? !hidden.has(SCHEDULE_GROUP) && !hidden.has(kindKey(kindOf(t))) && !hidden.has(labelKey(labelKeyOf(t)))
        : !hidden.has(TASK_GROUP) && !hidden.has(scopeKey(t.teamId)) && !hidden.has(statusKey(t.status)));
    const all = toCalendarItems(data ?? []);
    const meetings = toCalendarItems(meetingOcc.tasks).items;
    return { items: [...all.items.filter((it) => shown(it.task)), ...meetings], undated: all.undated.filter(shown) };
  }, [data, hidden, labelKeyOf, meetingOcc]);

  // タスク rows: 個人, then every team the caller has tasks in or added, named from 運営チーム.
  const teamById = useMemo(() => new Map((teamsQuery.data?.teams ?? []).map((t) => [t.id as string, t])), [teamsQuery.data]);
  const taskTeamIds = useMemo(() => {
    const ids = new Set<string>(teamsQuery.data?.myTeamIds ?? []);
    for (const t of data ?? []) if (t.teamId && !isScheduleTask(t)) ids.add(t.teamId);
    for (const id of watchedTeams) ids.add(id);
    return [...ids].sort((a, b) => (teamById.get(a)?.name ?? a).localeCompare(teamById.get(b)?.name ?? b, "ja"));
  }, [data, teamsQuery.data, watchedTeams, teamById]);
  const teamName = (id: string) => teamById.get(id)?.name ?? "チーム";
  const scopeRows: FilterRow[] = [
    { key: scopeKey(null), label: "個人のタスク", color: LABEL_COLOR },
    ...taskTeamIds.map((id) => {
      const watched = watchedTeams.includes(id);
      return {
        key: scopeKey(id),
        label: teamName(id),
        color: teamById.get(id)?.color ?? LABEL_COLOR,
        note: watched ? "メンバー全員の分" : "自分の分のみ",
        ...(watched
          ? {
              trailing: (
                <RemoveTeamButton
                  name={teamName(id)}
                  onRemove={() => setWatchedTeams((w) => w.filter((x) => x !== id))}
                />
              ),
            }
          : {}),
      };
    }),
  ];
  const addableTeams = (teamsQuery.data?.teams ?? []).filter((t) => !watchedTeams.includes(t.id));
  const notSearchable = useMemo(
    () => new Set([...(currentUserId ? [currentUserId] : []), ...watchedPeopleIds]),
    [currentUserId, watchedPeopleIds],
  );
  const addPerson = (u: identity.UserSummary) =>
    setWatchedPeople((w) => (w.some((p) => p.id === u.id) ? w : [...w, { id: u.id, name: u.displayName }]));
  const removePerson = (id: string) => {
    setWatchedPeople((w) => w.filter((p) => p.id !== id));
    setHiddenKeys((prev) => prev.filter((k) => k !== personKey(id)));
  };

  // ── mutations (optimistic: reflect first, roll back on failure) ──────────
  // The key is captured per mutation: adding/removing a team mid-flight changes it.
  const snapshot = async () => {
    const key = queryKey;
    await qc.cancelQueries({ queryKey: key });
    return { key, prev: qc.getQueryData<task.Task[]>(key) };
  };
  const rollback = (ctx: { key: typeof queryKey; prev: task.Task[] | undefined } | undefined, title: string) => {
    if (ctx) qc.setQueryData(ctx.key, ctx.prev);
    toast.show({ kind: "error", title });
  };
  const settle = () => void qc.invalidateQueries({ queryKey: ["calendar", "tasks", currentUserId] });
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
      const snap = await snapshot();
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
      qc.setQueryData<task.Task[]>(snap.key, (old) => [...(old ?? []), temp]);
      return { ...snap, tempId: temp.id };
    },
    onError: (_e, _d, ctx) => rollback(ctx, "予定を保存できませんでした"),
    onSuccess: (created, draft, ctx) => {
      if (!ctx) return;
      qc.setQueryData<task.Task[]>(ctx.key, (old) => (old ?? []).map((t) => (t.id === ctx?.tempId ? created : t)));
      toast.show({ kind: "success", title: draft.kind === "vacation" ? "休暇を登録しました" : "予定を保存しました" });
    },
    onSettled: settle,
  });

  const updateMut = useMutation({
    mutationFn: ({ item, draft }: { item: CalendarItem; draft: EventDraft }) =>
      api.updateTask(item.task.id, { version: item.task.version, ...fields(draft) }),
    onMutate: async ({ item, draft }) => {
      const snap = await snapshot();
      qc.setQueryData<task.Task[]>(snap.key, (old) =>
        (old ?? []).map((t) => (t.id === item.task.id ? { ...t, ...fields(draft) } : t)),
      );
      return snap;
    },
    onError: (_e, _v, ctx) => rollback(ctx, "予定を更新できませんでした"),
    onSuccess: (updated, _v, ctx) => {
      if (!ctx) return;
      qc.setQueryData<task.Task[]>(ctx.key, (old) => (old ?? []).map((t) => (t.id === updated.id ? updated : t)));
      toast.show({ kind: "success", title: "予定を更新しました" });
    },
    onSettled: settle,
  });

  const deleteMut = useMutation({
    mutationFn: (item: CalendarItem) => api.deleteTask(item.task.id),
    onMutate: async (item) => {
      const snap = await snapshot();
      qc.setQueryData<task.Task[]>(snap.key, (old) => (old ?? []).filter((t) => t.id !== item.task.id));
      return snap;
    },
    onError: (_e, _v, ctx) => rollback(ctx, "予定を削除できませんでした"),
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
    // The calendar just written to is shown, even if it was unticked (it lands where the user looks).
    if (!isTargetVisible(body.targetId)) setTargetChoices((prev) => ({ ...prev, [body.targetId]: true }));
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
                    disabled={!accountReady || createMeeting.isPending}
                    loading={createMeeting.isPending}
                    testId="calendar-meetings-create"
                  >
                    {createMeeting.isPending ? "作成中…" : "ミーティングを設定"}
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

              <div className={styles.calGroup}>
                <PeopleSearch search={(q) => api.searchUsers(q)} exclude={notSearchable} onAdd={addPerson} />
                {watchedPeople.length > 0 && (
                  <div data-testid="calendar-people-added">
                    {watchedPeople.map((p) => (
                      <FilterCheck
                        key={p.id}
                        row={{
                          key: personKey(p.id),
                          label: p.name,
                          color: LABEL_COLOR,
                          trailing: <RemoveTeamButton name={p.name} onRemove={() => removePerson(p.id)} />,
                        }}
                        checked={!hidden.has(personKey(p.id))}
                        onToggle={() => toggleFilter(personKey(p.id))}
                      />
                    ))}
                  </div>
                )}
              </div>

              <FilterGroup
                groupKey={SCHEDULE_GROUP}
                title="予定"
                hidden={hidden}
                onToggle={toggleFilter}
                open={openSections}
                onToggleOpen={toggleSection}
                sections={[
                  {
                    key: "kind",
                    title: "種類",
                    rows: ITEM_KINDS.map((k) => ({ key: kindKey(k), label: KIND_VISUALS[k].label, color: KIND_VISUALS[k].color })),
                  },
                  {
                    key: "label",
                    title: "ラベル",
                    loading: rolesQuery.isPending,
                    rows: labels.map((l) => ({
                      key: labelKey(l.key),
                      label: l.key === PERSONAL_LABEL ? "個人の予定" : l.name,
                      color: LABEL_COLOR,
                    })),
                  },
                ]}
              />

              <FilterGroup
                groupKey={TASK_GROUP}
                title="タスク"
                hidden={hidden}
                onToggle={toggleFilter}
                open={openSections}
                onToggleOpen={toggleSection}
                sections={[
                  {
                    key: "scope",
                    title: "個人・チーム",
                    rows: scopeRows,
                    footer: (
                      <AddTeamPicker
                        teams={addableTeams}
                        onAdd={(id) => setWatchedTeams((w) => (w.includes(id) ? w : [...w, id]))}
                      />
                    ),
                  },
                  {
                    key: "status",
                    title: "状態",
                    rows: STATUS_ORDER.map((st) => ({ key: statusKey(st), label: statusVisual(st).label, color: statusVisual(st).color })),
                  },
                ]}
              />

              {access.canView && (
                <MeetingFilter
                  targets={targets}
                  visible={new Set(targets.map((t) => t.id).filter(isTargetVisible))}
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
                  onChange={(ids) =>
                    setTargetChoices((prev) => ({ ...prev, ...Object.fromEntries(targets.map((t) => [t.id, ids.includes(t.id)])) }))
                  }
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
            // タスク are edited in マイタスク: saving one here would turn it into a 予定.
            canWrite={canWrite && !panel.item.task.id.startsWith("tmp_") && isScheduleTask(panel.item.task)}
            canDelete={canDelete && !panel.item.task.id.startsWith("tmp_") && isScheduleTask(panel.item.task)}
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
