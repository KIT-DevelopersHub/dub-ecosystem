import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Button, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTasks, createTask, resolveUsers, createTaskAttachment, issueTaskRequest } from "../api/endpoints";
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
import { MyTaskRequests } from "./MyTaskRequests";
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
    for (const t of tasks) {
      if (t.eventId && !seen.has(t.eventId)) seen.set(t.eventId, { id: t.eventId, name: t.eventId });
    }
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
    // The ガント workspace is event-scoped (FE3 owns /events/:eventId). An unlinked
    // task (判断44) has no event workspace, so this escape hatch only applies when the
    // task is linked; the detail dialog already shows everything for unlinked tasks.
    if (t.eventId && typeof window !== "undefined") {
      window.location.assign(`/events/${t.eventId}/tasks/${t.id}`);
    }
  };

  // Best-effort attachment persistence after a task exists (needs its real id). A failed
  // attachment must never undo an already-created task.
  const attachBestEffort = async (taskId: common.TaskId, attachments: MyTaskDraft["attachments"]) => {
    if (attachments.files.length + attachments.urls.length === 0) return;
    try {
      for (const f of attachments.files) {
        await createTaskAttachment(client, taskId, { kind: "file", name: f.name, url: f.url, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
      }
      for (const u of attachments.urls) {
        await createTaskAttachment(client, taskId, { kind: "url", name: u.name, url: u.url });
      }
    } catch {
      toast.show({ kind: "error", title: "一部の添付を保存できませんでした", description: "タスクは作成済みです。詳細から再度添付できます。" });
    }
  };

  // 送る (依頼): when a 依頼先 is chosen, the submit goes through POST /task-requests. The
  // SERVER decides (never the client): 自分/自チーム → タスク即作成 (task), 他チーム →
  // 承認待ちの依頼 (request). Cross-team work therefore can be requested from マイタスク
  // even though ガント never lets you draw a cross-team arrow.
  const onIssueRequest = async (draft: MyTaskDraft, toUserId: common.UserId) => {
    try {
      const res = await issueTaskRequest(client, {
        toUserId,
        title: draft.title,
        ...(draft.description !== null ? { description: draft.description } : {}),
        priority: draft.priority,
        ...(draft.eventId ? { eventId: draft.eventId } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
        ...(draft.teamId ? { targetTeamId: draft.teamId } : {}),
      });
      if (res.kind === "task") {
        // self / same team → materialised now. Surface it + best-effort attachments.
        await attachBestEffort(res.task.id, draft.attachments);
        const belongs =
          lens === "all" || lens === "requested" || (lens === "assigned" && res.task.assigneeId === currentUserId);
        if (belongs) setTasks((prev) => [res.task, ...prev.filter((t) => t.id !== res.task.id)]);
        toast.show({ kind: "success", title: "タスクを作成しました" });
      } else {
        // other team → pending request; it appears under 送った依頼 (承認待ち).
        const toName = users.get(toUserId)?.displayName ?? "相手";
        toast.show({ kind: "success", title: "依頼を送信しました", description: `${toName} の承認を待っています。` });
      }
    } catch (e) {
      toast.show({ kind: "error", title: "依頼に失敗しました", description: "もう一度お試しください。" });
      throw e;
    }
  };

  const onCreate = async (draft: MyTaskDraft) => {
    // A 依頼先 (assignee) → route through the request flow (server branches self/team/other).
    if (draft.assigneeId) return onIssueRequest(draft, draft.assigneeId);

    // No assignee → a personal/team task: direct optimistic create with a temporary id.
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
        ...(draft.eventId ? { eventId: draft.eventId } : {}),
        title: draft.title,
        ...(draft.description !== null ? { description: draft.description } : {}),
        priority: draft.priority,
        ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
        ...(draft.teamId ? { teamId: draft.teamId } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
      });
      await attachBestEffort(created.id, draft.attachments);
      // reconcile the temp row with the server task (or drop it if out of lens).
      setTasks((prev) => {
        const withoutTemp = prev.filter((t) => t.id !== tempId);
        return belongs ? [created, ...withoutTemp] : withoutTemp;
      });
      toast.show({ kind: "success", title: "タスクを作成しました" });
    } catch (e) {
      setTasks((prev) => prev.filter((t) => t.id !== tempId)); // rollback
      toast.show({ kind: "error", title: "作成に失敗しました", description: "もう一度お試しください。" });
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
        <Button onClick={() => setCreateOpen(true)} testId="fe4-mytasks-create-open">
          ＋ タスクを依頼
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

      <MyTaskRequests seedUsers={effectivePeople} onChanged={load} />

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
        title="タスクを依頼"
        submitLabel="依頼する"
      />
    </section>
  );
}
