import { useCallback, useEffect, useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Button, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { createTask, createTaskAttachment, getGantt, issueTaskRequest, replaceDependencies } from "../api/endpoints";
import { scopeTasksFromRows, type ScopeTask } from "../domain/task-hierarchy";
import { MyTaskCreateModal, type MyTaskDraft, type EventOption } from "./MyTaskCreateModal";
import { MyTaskRequests } from "./MyTaskRequests";
import styles from "../styles/app.module.css";

export interface MyTasksPageProps {
  currentUserId: common.UserId;
  /** roster for the create modal 依頼先 select (and the チャット差出人/宛名の名前解決). */
  people: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  events: readonly EventOption[];
  /** 対象イベントの初期値 for 「タスクを依頼」 — the globally header-selected event.
   *  Passed straight to the create modal; null = start unlinked. */
  initialEventId?: common.EventId | null;
  /** チームの初期値 for 「タスクを依頼」 — the team the logged-in user belongs to. Passed to
   *  the create modal; null = start 未割当. */
  defaultTeamId?: common.TeamId | null;
}

/**
 * マイタスク — 「送る・受け取る」の依頼だけを、チャット風のタイムラインで扱うハブ。
 * 表形式の一覧・タイトル検索・担当者フィルタは廃止し、「いまボールを持つのは誰か」で
 * 左右を分けたやりとり (MyTaskRequests) に集中する:
 *   - 自分が対応すべき（自分がボール）  → 右
 *   - 自分が誰かに渡した（相手がボール・状況を見るだけ） → 左（自分側に ← を描く）
 * 「＋タスクを依頼」で 依頼先 を選ぶと送る依頼になる（相手の承認待ち＝左の相手ボール）。
 */
export function MyTasksPage({ currentUserId, people, teams, events, initialEventId, defaultTeamId }: MyTasksPageProps) {
  const client = useApiClient();
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  // ③ 親タスク・先行タスクの候補は「作成モーダルで選択中の対象イベント」のタスク（＝そのイベントの
  // ガント読み取りモデル）。既定はヘッダー選択中イベント。モーダルで対象イベントを変えたら onEventChange
  // で scopeEventId を差し替えて候補を読み直す（親子・依存は同一イベント内でのみ・別チーム依存は不可）。
  const [scopeEventId, setScopeEventId] = useState<common.EventId | null>(initialEventId ?? null);
  const [scopeTasks, setScopeTasks] = useState<readonly ScopeTask[]>([]);
  useEffect(() => {
    if (!scopeEventId) {
      setScopeTasks([]);
      return;
    }
    let live = true;
    void getGantt(client, scopeEventId)
      .then((dto) => {
        if (live) setScopeTasks(scopeTasksFromRows(dto.rows));
      })
      .catch(() => {
        // イベントにガントが無い/未紐付け等 → 候補なし（親/先行欄は出さない）。degrade gracefully。
        if (live) setScopeTasks([]);
      });
    return () => {
      live = false;
    };
  }, [client, scopeEventId]);
  // Bumping this key remounts MyTaskRequests → it reloads its own boxes after a
  // send (依頼) so the new 送った依頼 card appears without a table to reconcile.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

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
  // 承認待ちの依頼 (request). Cross-team work therefore can be requested from マイタスク.
  const onIssueRequest = async (draft: MyTaskDraft, toUserId: common.UserId) => {
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

  const onCreate = async (draft: MyTaskDraft) => {
    // A 依頼先 (assignee) → route through the request flow (server branches self/team/other).
    if (draft.assigneeId) return onIssueRequest(draft, draft.assigneeId);

    // No assignee → a personal/team task: direct create (no list to reconcile).
    try {
      const created = await createTask(client, {
        ...(draft.eventId ? { eventId: draft.eventId } : {}),
        title: draft.title,
        ...(draft.description !== null ? { description: draft.description } : {}),
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.teamId ? { teamId: draft.teamId } : {}),
        ...(draft.startAt ? { startAt: draft.startAt } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
        // ③ 親タスク（親子関係）。子は親と同じチーム（モーダルで固定済み）。
        ...(draft.parentId ? { parentTaskId: draft.parentId } : {}),
      });
      await attachBestEffort(created.id, draft.attachments);
      // ③ 先行タスク（依存）。タスク作成後に別途反映（同一チーム内のみ）。失敗しても作成は取り消さない。
      if (draft.dependsOnIds.length > 0) {
        try {
          await replaceDependencies(client, created.id, { version: created.version, dependsOnIds: draft.dependsOnIds });
        } catch {
          toast.show({ kind: "error", title: "一部の先行タスクを設定できませんでした", description: "タスクは作成済みです。詳細から設定し直せます。" });
        }
      }
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

      <MyTaskCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        events={effectiveEvents}
        people={effectivePeople}
        teams={teams}
        onCreate={onCreate}
        requesterName={currentUserName}
        defaultEventId={initialEventId ?? null}
        defaultTeamId={defaultTeamId ?? null}
        scopeTasks={scopeTasks}
        scopeEventId={scopeEventId}
        onEventChange={setScopeEventId}
        title="タスクを依頼"
        submitLabel="依頼する"
      />
    </section>
  );
}
