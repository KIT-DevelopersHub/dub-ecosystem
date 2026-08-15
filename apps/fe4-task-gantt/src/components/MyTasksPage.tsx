import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Button, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTasks, createTask, resolveUsers } from "../api/endpoints";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import {
  type MyTasksFilter,
  type MyTasksLens,
  emptyMyTasksFilter,
  lensQueries,
  mergeTasks,
  applyMyTasksFilter,
  sortMyTasks,
} from "../domain/my-tasks";
import { MyTasksFilterBar } from "./MyTasksFilterBar";
import { MyTaskList } from "./MyTaskList";
import { MyTaskCreateModal, type MyTaskDraft, type EventOption } from "./MyTaskCreateModal";
import { TaskDetailDialog } from "./TaskDetailDialog";
import styles from "../styles/app.module.css";

const PAGE_SIZE = 25;

const LENS_TABS: { key: MyTasksLens; label: string; hint: string }[] = [
  { key: "assigned", label: "担当", hint: "自分に割り当てられたタスク" },
  { key: "requested", label: "依頼", hint: "自分が発行したタスク" },
  { key: "all", label: "すべて", hint: "自分に関わる全タスク" },
];

export interface MyTasksPageProps {
  currentUserId: common.UserId;
  /** roster for the filter selects + create modal 依頼先. */
  people: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  events: readonly EventOption[];
}

/**
 * マイタスク hub — a clear, filterable list of the tasks a person is involved in,
 * built for 300 people. Two lenses (担当 assigned-to-me / 依頼 issued-by-me) plus
 * 「すべて」, unified into one list that shows 依頼→担当 (from→to). Create is
 * optimistic (the new task appears instantly, rolls back on error).
 */
export function MyTasksPage({ currentUserId, people, teams, events }: MyTasksPageProps) {
  const client = useApiClient();
  const toast = useToast();

  const [lens, setLens] = useState<MyTasksLens>("assigned");
  const [filter, setFilter] = useState<MyTasksFilter>(() => emptyMyTasksFilter());
  const [tasks, setTasks] = useState<task.Task[]>([]);
  const [users, setUsers] = useState<UserCache>(() => createUserCache(people));
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<task.Task | null>(null);
  const reqSeq = useRef(0);

  const teamNames = useMemo(() => new Map(teams.map((t) => [t.id, t.name] as const)), [teams]);

  // Fallbacks so the hub works in the shell too, where the caller may not have a
  // roster / event list to hand: people fall back to whoever appears in the tasks,
  // events fall back to the distinct events those tasks belong to (id as label).
  const effectivePeople = useMemo<readonly identity.UserSummary[]>(
    () => (people.length > 0 ? people : [...users.values()]),
    [people, users],
  );
  const effectiveEvents = useMemo<readonly EventOption[]>(() => {
    if (events.length > 0) return events;
    const seen = new Map<common.EventId, EventOption>();
    for (const t of tasks) if (!seen.has(t.eventId)) seen.set(t.eventId, { id: t.eventId, name: t.eventId });
    return [...seen.values()];
  }, [events, tasks]);
  const currentUserName = useMemo(
    () => users.get(currentUserId)?.displayName ?? people.find((p) => p.id === currentUserId)?.displayName ?? "自分",
    [users, people, currentUserId],
  );

  // fetch the lens' task set (one or two self-scoped queries, merged + deduped).
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const queries = lensQueries(currentUserId, lens);
      const pages = await Promise.all(queries.map((q) => listTasks(client, q)));
      if (seq !== reqSeq.current) return; // a newer load superseded this one
      const merged = mergeTasks(...pages.map((p) => p.items));
      setTasks(merged);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [client, currentUserId, lens]);

  useEffect(() => {
    void load();
  }, [load]);

  // resolve requester + assignee display names (batched, cache-backed).
  useEffect(() => {
    const ids = tasks.flatMap((t) => [t.createdBy ?? null, t.assigneeId]);
    void ensureUsers(users, ids, (batch) => resolveUsers(client, batch)).then((c) => setUsers(new Map(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // reset the reveal window when the visible result set changes shape.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [lens, filter]);

  const visible = useMemo(() => {
    const filtered = applyMyTasksFilter(tasks, filter);
    return sortMyTasks(filtered, filter.sort);
  }, [tasks, filter]);

  // Explicit escape hatch from the detail dialog to the full ガント workspace —
  // the row click itself now opens the dialog (feedback #2), so this no longer
  // fires on every click and the two behaviors don't conflict.
  const openWorkspace = (t: task.Task) => {
    if (typeof window !== "undefined") window.location.assign(`/events/${t.eventId}/tasks/${t.id}`);
  };

  const onCreate = async (draft: MyTaskDraft) => {
    // optimistic: show the new task immediately with a temporary id.
    const tempId = `task_temp_${Date.now()}` as common.TaskId;
    const now = new Date().toISOString();
    const optimistic: task.Task = {
      id: tempId,
      eventId: draft.eventId,
      title: draft.title,
      description: draft.description,
      status: "todo",
      priority: draft.priority,
      assigneeId: draft.assigneeId,
      teamId: draft.teamId,
      createdBy: currentUserId,
      dueAt: draft.dueAt,
      origin: "internal",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    // only surface it in the current lens if it belongs there.
    const belongs = lens === "all" || lens === "requested" || (lens === "assigned" && draft.assigneeId === currentUserId);
    if (belongs) setTasks((prev) => [optimistic, ...prev]);
    try {
      const created = await createTask(client, {
        eventId: draft.eventId,
        title: draft.title,
        ...(draft.description !== null ? { description: draft.description } : {}),
        priority: draft.priority,
        ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
        ...(draft.teamId ? { teamId: draft.teamId } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
      });
      // reconcile the temp row with the server task (or drop it if out of lens).
      setTasks((prev) => {
        const withoutTemp = prev.filter((t) => t.id !== tempId);
        return belongs ? [created, ...withoutTemp] : withoutTemp;
      });
      toast.show({ kind: "success", title: "タスクを発行しました" });
    } catch (e) {
      setTasks((prev) => prev.filter((t) => t.id !== tempId)); // rollback
      toast.show({ kind: "error", title: "発行に失敗しました", description: "もう一度お試しください。" });
      throw e;
    }
  };

  return (
    <section className={styles.myPage} data-testid="fe4-me-tasks">
      <header className={styles.myHeader}>
        <div>
          <h1 className={styles.myTitle}>マイタスク</h1>
          <p className={styles.mySubtitle}>自分に関わるタスクを、誰から誰へかが分かる一覧で管理できます。</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} testId="fe4-mytasks-create-open" disabled={effectiveEvents.length === 0}>
          ＋ タスクを発行
        </Button>
      </header>

      <div className={styles.lensTabs} role="tablist" aria-label="表示するタスクの範囲">
        {LENS_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={lens === t.key}
            title={t.hint}
            className={`${styles.lensTab} ${lens === t.key ? styles.lensTabActive : ""}`}
            onClick={() => setLens(t.key)}
            data-testid={`fe4-mytasks-lens-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <MyTasksFilterBar
        value={filter}
        onChange={setFilter}
        onClear={() => setFilter(emptyMyTasksFilter())}
        people={effectivePeople}
        teams={teams}
      />

      <MyTaskList
        tasks={visible}
        users={users}
        teamNames={teamNames}
        loading={loading}
        onSelect={setSelected}
        visibleCount={visibleCount}
        onShowMore={() => setVisibleCount((n) => n + PAGE_SIZE)}
      />

      <TaskDetailDialog
        task={selected}
        users={users}
        teamNames={teamNames}
        onClose={() => setSelected(null)}
        onOpenWorkspace={openWorkspace}
      />

      <MyTaskCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        events={effectiveEvents}
        people={effectivePeople}
        teams={teams}
        onCreate={onCreate}
        requesterName={currentUserName}
      />
    </section>
  );
}
