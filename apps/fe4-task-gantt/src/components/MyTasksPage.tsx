import { useCallback, useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Button, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { createTask, createTaskAttachment, issueTaskRequest, listTasks } from "../api/endpoints";
import { TaskCreateModal, type TaskDraft, type EventOption } from "./TaskCreateModal";
import type { ScopeTask } from "../domain/task-hierarchy";
import { MyTaskRequests } from "./MyTaskRequests";
import styles from "../styles/app.module.css";

export interface MyTasksPageProps {
  currentUserId: common.UserId;
  /** roster for the create modal 依頼先 select (and the チャット差出人/宛名の名前解決). */
  people: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  events: readonly EventOption[];
}

/**
 * マイタスク — 「送る・受け取る」の依頼だけを、チャット風のタイムラインで扱うハブ。
 * 表形式の一覧・タイトル検索・担当者フィルタは廃止し、「いまボールを持つのは誰か」で
 * 左右を分けたやりとり (MyTaskRequests) に集中する:
 *   - 自分が対応すべき（自分がボール）  → 右
 *   - 自分が誰かに渡した（相手がボール・状況を見るだけ） → 左（自分側に ← を描く）
 * 「＋タスクを依頼」で 依頼先 を選ぶと送る依頼になる（相手の承認待ち＝左の相手ボール）。
 */
export function MyTasksPage({ currentUserId, people, teams, events }: MyTasksPageProps) {
  const client = useApiClient();
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  // Bumping this key remounts MyTaskRequests → it reloads its own boxes after a
  // send (依頼) so the new 送った依頼 card appears without a table to reconcile.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  // 親/先行の候補は「選択中の対象イベント」のタスク一覧から作る。対象イベントを選ぶと
  // その場でロードして、共通の作成モーダルにガントと同じ 親/先行 UI を出す（③ 共通化）。
  const [scopeTasks, setScopeTasks] = useState<readonly ScopeTask[]>([]);
  const loadScopeForEvent = useCallback(
    async (eventId: common.EventId | null) => {
      if (!eventId) {
        setScopeTasks([]);
        return;
      }
      try {
        const res = await listTasks(client, { eventId });
        setScopeTasks(
          res.items.map((t) => ({
            id: t.id,
            title: t.title,
            parentTaskId: t.parentTaskId ?? null,
            teamId: t.teamId ?? null,
          })),
        );
      } catch {
        setScopeTasks([]); // 候補が取れなければ 親/先行 欄は出さない（degrade gracefully）。
      }
    },
    [client],
  );
  const parentOptions = useMemo(
    () => scopeTasks.map((t) => ({ id: t.id, title: t.title })),
    [scopeTasks],
  );

  // Fallbacks so the hub works in the shell too, where the caller may not hand a
  // full roster / event list: people/events fall back to empty (the modal then
  // shows just「紐付けない」/未割当, and the チャット resolves names on demand).
  const effectivePeople = useMemo<readonly identity.UserSummary[]>(() => people, [people]);
  const effectiveEvents = useMemo<readonly EventOption[]>(() => events, [events]);
  const currentUserName = useMemo(
    () => people.find((p) => p.id === currentUserId)?.displayName ?? "自分",
    [people, currentUserId],
  );

  // Best-effort attachment persistence after a task exists (needs its real id). A failed
  // attachment must never undo an already-created task.
  const attachBestEffort = async (taskId: common.TaskId, attachments: TaskDraft["attachments"]) => {
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
  // 承認待ちの依頼 (request). Cross-team work therefore can be requested from マイタスク.
  const onIssueRequest = async (draft: TaskDraft, toUserId: common.UserId) => {
    try {
      const res = await issueTaskRequest(client, {
        toUserId,
        title: draft.title,
        ...(draft.description !== null ? { description: draft.description } : {}),
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.eventId ? { eventId: draft.eventId } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
        ...(draft.teamId ? { targetTeamId: draft.teamId } : {}),
      });
      if (res.kind === "task") {
        // self / same team → materialised now. Best-effort attachments.
        await attachBestEffort(res.task.id, draft.attachments);
        toast.show({ kind: "success", title: "タスクを作成しました" });
      } else {
        // other team → pending request; it appears as a 送った依頼 card (相手のボール).
        const toName = people.find((p) => p.id === toUserId)?.displayName ?? "相手";
        toast.show({ kind: "success", title: "依頼を送信しました", description: `${toName} の承認を待っています。` });
      }
      reload();
    } catch (e) {
      toast.show({ kind: "error", title: "依頼に失敗しました", description: "もう一度お試しください。" });
      throw e;
    }
  };

  const onCreate = async (draft: TaskDraft) => {
    // A 依頼先 (assignee) → route through the request flow (server branches self/team/other).
    if (draft.assigneeId) return onIssueRequest(draft, draft.assigneeId);

    // No assignee → a personal/team task: direct create (no list to reconcile).
    // 対象イベントを選び 親タスク を指定していれば WBS 親も引き継ぐ（③ 親/先行 共通化）。
    try {
      const created = await createTask(client, {
        ...(draft.eventId ? { eventId: draft.eventId } : {}),
        title: draft.title,
        ...(draft.description !== null ? { description: draft.description } : {}),
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.teamId ? { teamId: draft.teamId } : {}),
        ...(draft.startAt ? { startAt: draft.startAt } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
        ...(draft.parentTaskId ? { parentTaskId: draft.parentTaskId } : {}),
      });
      await attachBestEffort(created.id, draft.attachments);
      toast.show({ kind: "success", title: "タスクを作成しました" });
    } catch (e) {
      toast.show({ kind: "error", title: "作成に失敗しました", description: "もう一度お試しください。" });
      throw e;
    }
  };

  return (
    <section className={styles.myPage} data-testid="fe4-me-tasks">
      <header className={styles.myHeader}>
        <h1 className={styles.myTitle}>マイタスク</h1>
        <Button onClick={() => setCreateOpen(true)} testId="fe4-mytasks-create-open">
          ＋ タスクを依頼
        </Button>
      </header>

      <MyTaskRequests key={reloadKey} seedUsers={effectivePeople} onChanged={reload} />

      <TaskCreateModal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setScopeTasks([]);
        }}
        users={effectivePeople}
        teams={teams}
        parentOptions={parentOptions}
        scopeTasks={scopeTasks}
        onCreate={onCreate}
        requesterName={currentUserName}
        title="タスクを依頼"
        submitLabel="依頼する"
        testIdPrefix="fe4-mytask-create"
        showStatus={false}
        showStart={false}
        showEvent
        showDescription
        showAttachments
        events={effectiveEvents}
        onEventChange={loadScopeForEvent}
      />
    </section>
  );
}
