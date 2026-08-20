import { useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Button, Modal, TextField, Textarea, Select, ConfirmDialog } from "@dub/ui";
import { allowedTransitions } from "../domain/status-transitions";
import { PRIORITY_LABEL, STATUS_LABEL, dateInputFromIso, isoFromDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker } from "./PredecessorPicker";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { TaskAttachmentsEditor } from "./TaskAttachmentsEditor";
import styles from "../styles/app.module.css";

const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

/** Relation edits committed alongside the field patch (先行タスク＝依存 / 親子). */
export interface RelationEdit {
  parentChanged: boolean;
  parentTaskId: common.TaskId | null;
  depsChanged: boolean;
  dependsOnIds: common.TaskId[];
}

export interface TaskDetailPanelProps {
  task: task.Task;
  users: readonly identity.UserSummary[];
  teams?: readonly team.Team[];
  onSave: (patch: task.UpdateTaskRequest, relations: RelationEdit) => void;
  onDelete: () => void;
  /** Called instead of opening the delete confirm when the task still has children
   *  (deleting would orphan them). The host surfaces this as a bottom-right warning
   *  toast (#375) — the old inline block message under the button was hard to notice. */
  onDeleteBlocked?: (childCount: number) => void;
  onClose: () => void;
  /** "ここから子タスクを作成": open the create modal with this task preset as the parent. */
  onCreateChild?: (parentId: common.TaskId) => void;
  /** "先行タスクを作成": create a new task and link it as this task's predecessor. */
  onCreatePredecessor?: (taskId: common.TaskId) => void;
  /** Candidate WBS parents (excludes this task). */
  parentOptions?: readonly { id: common.TaskId; title: string }[];
  /** This task's current WBS parent (親タスク), or null if top-level. */
  parentTaskId?: common.TaskId | null;
  /** every task with its direct parent — predecessors are scoped to same-parent
   *  siblings of the (possibly re-parented) task (判断10). */
  scopeTasks?: readonly ScopeTask[];
  /** This task's current predecessors (先行タスク＝依存元). */
  dependsOnIds?: readonly common.TaskId[];
  /** The bar's DISPLAYED window (gantt row startsAt/endsAt). Seeds 開始日/期日 when the
   *  task has no explicit startAt/dueAt column yet — the gantt read model derives a bar
   *  window from dueAt (＋priority/CPM), so a task with only dueAt still SHOWS a start on
   *  its bar while its startAt column is null. Seeding from here makes 値(詳細)=バー=横軸. */
  barStartsAt?: common.ISODateTime | null;
  barEndsAt?: common.ISODateTime | null;
  /** True when this task is a WBS parent (work-package). A parent's bar span is the
   *  ROLLUP of its children, so the rolled bar window — not the parent's own (possibly
   *  stale) start_at/due_at column — is the authoritative value to show (症状#7 値ズレ). */
  hasChildren?: boolean;
  fieldErrors?: Record<string, string>;
  canWrite: boolean;
  canDelete: boolean;
}

/** Side panel: edit form (title/status/priority/assignee/due) + delete confirm. */
export function TaskDetailPanel({
  task: t,
  users,
  teams = [],
  onSave,
  onDelete,
  onDeleteBlocked,
  onClose,
  onCreateChild,
  onCreatePredecessor,
  parentOptions = [],
  parentTaskId = null,
  scopeTasks = [],
  dependsOnIds = [],
  barStartsAt = null,
  barEndsAt = null,
  hasChildren = false,
  fieldErrors,
  canWrite,
  canDelete,
}: TaskDetailPanelProps) {
  const [title, setTitle] = useState(t.title);
  const [description, setDescription] = useState(t.description ?? "");
  const [status, setStatus] = useState<task.TaskStatus>(t.status);
  const [priority, setPriority] = useState<task.TaskPriority>(t.priority);
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(t.assigneeId);
  const [teamId, setTeamId] = useState<common.TeamId | null>(t.teamId ?? null);
  // Seed the date fields so 開始日/期日 always equal what the bar (and the axis) show.
  //  - LEAF task: prefer its own start_at/due_at column, falling back to the bar's derived
  //    window when the column is still null (real seed sets only due_at).
  //  - PARENT (work-package): its bar is the ROLLUP of its children, and its own
  //    start_at/due_at column is authoritatively null in the read model — but a stale value
  //    can linger in the task row from before it had children. The rolled bar window is the
  //    single source of truth, so it WINS over the stored column (症状#7 親子の値ズレ: detail
  //    /save must never show a parent date that disagrees with its children's rollup).
  const startInputSeed = dateInputFromIso(
    hasChildren ? barStartsAt ?? t.startAt ?? null : t.startAt ?? barStartsAt ?? null,
  );
  const dueInputSeed = dateInputFromIso(
    hasChildren ? barEndsAt ?? t.dueAt ?? null : t.dueAt ?? barEndsAt ?? null,
  );
  const [start, setStart] = useState<string | null>(startInputSeed);
  const [due, setDue] = useState<string | null>(dueInputSeed);
  // Relations (親子 / 先行タスク). Seeded from the gantt read model via props; the
  // panel is remounted per task (keyed on id) so these never go stale.
  const [parentId, setParentId] = useState<common.TaskId | null>(parentTaskId);
  const [deps, setDeps] = useState<common.TaskId[]>([...dependsOnIds]);
  const [confirming, setConfirming] = useState(false);

  // Predecessors are limited to this task's siblings under its (possibly changed)
  // parent — same scope only (判断10). Excludes self.
  const depOptions = useMemo(
    () => dependencyScopeOptions(scopeTasks, parentId, t.id),
    [scopeTasks, parentId, t.id],
  );
  // How many tasks hang directly under this one (親タスクなら子の数を明示・feedback #39).
  const childCount = useMemo(
    () => scopeTasks.filter((s) => s.parentTaskId === t.id).length,
    [scopeTasks, t.id],
  );

  // status may move only to an allowed target (or stay) — same source as board D&D
  const statusOptions = [t.status, ...allowedTransitions(t.status)].filter((s, i, arr) => arr.indexOf(s) === i);
  const nextStartIso = isoFromDateInput(start);
  const nextDueIso = isoFromDateInput(due);
  // A date edit relative to the seeded (displayed) window.
  const datesChanged = start !== startInputSeed || due !== dueInputSeed;
  const curTeam = t.teamId ?? null;
  const parentChanged = parentId !== parentTaskId;
  const sameDeps =
    deps.length === dependsOnIds.length && deps.every((id) => dependsOnIds.includes(id));
  const depsChanged = !sameDeps;
  // メモ/詳細: an empty box clears the description (null), any text stores it.
  const curDescription = t.description ?? "";
  const descriptionChanged = description !== curDescription;
  const dirty =
    title !== t.title ||
    descriptionChanged ||
    status !== t.status ||
    priority !== t.priority ||
    assigneeId !== t.assigneeId ||
    teamId !== curTeam ||
    datesChanged ||
    parentChanged ||
    depsChanged;

  const save = () => {
    const patch: task.UpdateTaskRequest = { version: t.version };
    if (title !== t.title) patch.title = title;
    if (descriptionChanged) patch.description = description.trim() === "" ? null : description;
    if (status !== t.status) patch.status = status;
    if (priority !== t.priority) patch.priority = priority;
    if (assigneeId !== t.assigneeId) patch.assigneeId = assigneeId;
    if (teamId !== curTeam) patch.teamId = teamId;
    // Any 開始日/期日 change materialises BOTH edges (startsAt↔startAt, endsAt↔dueAt) so the
    // saved task carries an explicit window. The gantt bar then equals the detail values
    // exactly (no re-derivation drift when startAt was previously null), and the optimistic
    // bar move matches the authoritative refetch — no post-save jump.
    if (datesChanged) {
      patch.startAt = nextStartIso;
      patch.dueAt = nextDueIso;
    }
    if (parentChanged) patch.parentTaskId = parentId;
    onSave(patch, { parentChanged, parentTaskId: parentId, depsChanged, dependsOnIds: deps });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="タスクの詳細"
      size="lg"
      testId="fe4-detail-panel"
      footer={
        <div className={styles.modalFooter}>
          {canDelete && !confirming && (
            <Button
              variant="danger"
              // A task with children cannot be deleted (it would orphan them). Hand the block
              // to the host as a bottom-right warning toast (#375) instead of confirming.
              onClick={() => (childCount > 0 ? onDeleteBlocked?.(childCount) : setConfirming(true))}
              testId="fe4-detail-delete"
            >
              削除
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} testId="fe4-detail-close">
            閉じる
          </Button>
          <Button onClick={save} disabled={!canWrite || !dirty} testId="fe4-detail-save">
            保存
          </Button>
        </div>
      }
    >
      <div className={styles.detailPanelBody} aria-label="タスク詳細">
        <div className={styles.panelHeadInfo}>
          <TaskStatusBadge status={t.status} />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-detail-title">
            タイトル
          </label>
          <TextField id="fe4-detail-title" value={title} disabled={!canWrite} onChange={setTitle} testId="fe4-detail-title" />
          {fieldErrors?.title && (
            <span className={styles.fieldError} data-testid="fe4-error-title">
              {fieldErrors.title}
            </span>
          )}
        </div>

        {/* 内容: free-text body/notes captured on the task (optimistic save + toast). */}
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-detail-description">
            内容
          </label>
          <Textarea
            id="fe4-detail-description"
            value={description}
            disabled={!canWrite}
            onChange={setDescription}
            rows={4}
            placeholder="タスクの背景・手順・補足などを書けます"
            testId="fe4-detail-description"
          />
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-status">
              ステータス
            </label>
            <Select
              id="fe4-detail-status"
              value={status}
              disabled={!canWrite}
              onChange={(v) => setStatus(v as task.TaskStatus)}
              options={statusOptions.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              testId="fe4-detail-status"
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-priority">
              優先度
            </label>
            <Select
              id="fe4-detail-priority"
              value={priority}
              disabled={!canWrite}
              onChange={(v) => setPriority(v as task.TaskPriority)}
              options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              testId="fe4-detail-priority"
            />
          </div>
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-detail-assignee">
            担当
          </label>
          <Select
            id="fe4-detail-assignee"
            value={assigneeId ?? ""}
            disabled={!canWrite}
            onChange={(v) => setAssigneeId(v ? (v as common.UserId) : null)}
            options={[{ value: "", label: "未割当" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
            testId="fe4-detail-assignee"
          />
        </div>

        {/* 開始日 / 期日: a task with both gets an exact gantt bar (arrow-linkable). */}
        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-start">
              開始日
            </label>
            <DateField id="fe4-detail-start" value={start} disabled={!canWrite} onChange={setStart} testId="fe4-detail-start" />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-due">
              期日
            </label>
            <DateField id="fe4-detail-due" value={due} disabled={!canWrite} onChange={setDue} testId="fe4-detail-due" />
          </div>
        </div>

        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-team">
              チーム
            </label>
            <Select
              id="fe4-detail-team"
              value={teamId ?? ""}
              disabled={!canWrite}
              onChange={(v) => setTeamId(v ? (v as common.TeamId) : null)}
              options={[{ value: "", label: "未割当" }, ...teams.map((tm) => ({ value: tm.id, label: tm.name }))]}
              testId="fe4-detail-team"
            />
          </div>
        )}

        {/* 子タスク数: shown when this task is itself a work-package (親). */}
        {childCount > 0 && (
          <div className={styles.detailChildCount} data-testid="fe4-detail-child-count">
            <span className={styles.detailChildCountLabel}>子タスク</span>
            <span className={styles.detailChildCountValue}>{childCount}個</span>
          </div>
        )}

        {/* 親子（親タスク）: change/detach which work-package this task hangs under. */}
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-detail-parent">
            親タスク（親子関係）
          </label>
          <Select
            id="fe4-detail-parent"
            value={parentId ?? ""}
            disabled={!canWrite}
            onChange={(v) => {
              const next = v ? (v as common.TaskId) : null;
              setParentId(next);
              // dependencies must stay within the new scope — drop out-of-scope ones.
              setDeps((d) => pruneToScope(scopeTasks, next, d).filter((id) => id !== t.id));
            }}
            options={[{ value: "", label: "なし（トップレベル）" }, ...parentOptions.map((o) => ({ value: o.id, label: o.title }))]}
            testId="fe4-detail-parent"
          />
          {/* 関係タイプの変換: 親（親子）→ 先行（依存）。保存で親子/依存を一括反映。 */}
          {canWrite && parentId && (
            <button
              type="button"
              className={styles.relConvertBtn}
              onClick={() => {
                const p = parentId;
                setParentId(null);
                // detach to top-level, then keep p as a predecessor (same-scope only).
                setDeps((d) => pruneToScope(scopeTasks, null, [...new Set([...d, p])]).filter((id) => id !== t.id));
              }}
              data-testid="fe4-detail-parent-to-dep"
            >
              ⇄ 先行タスク（依存）に変換
            </button>
          )}
        </div>

        {/* 先行タスク（依存）: add/remove predecessors after the fact (same scope only).
            Each chip can be promoted to the 親タスク (依存→親子) via 「親に」. */}
        <div className={styles.formField}>
          <span className={styles.formLabel}>先行タスク（依存・同じ親のタスクのみ）</span>
          <PredecessorPicker
            options={canWrite ? depOptions : []}
            value={deps}
            onChange={(next) => canWrite && setDeps(next)}
            {...(canWrite
              ? {
                  onPromoteToParent: (id: common.TaskId) => {
                    // 依存 → 親子: this predecessor becomes the parent; drop it from deps,
                    // and re-scope the rest to the new parent (保存で一括反映).
                    setParentId(id);
                    setDeps((d) => pruneToScope(scopeTasks, id, d.filter((x) => x !== id)).filter((x) => x !== t.id));
                  },
                }
              : {})}
            testId="fe4-detail-deps"
          />
        </div>

        {canWrite && (onCreateChild || onCreatePredecessor) && (
          <div className={styles.relCreateRow}>
            {onCreateChild && (
              <button type="button" className={styles.childCreateBtn} onClick={() => onCreateChild(t.id)} data-testid="fe4-detail-create-child">
                ＋ 子タスクを作成
                <span className={styles.childCreateHint}>このタスクを親にして新規作成（親子）</span>
              </button>
            )}
            {onCreatePredecessor && (
              <button type="button" className={styles.childCreateBtn} onClick={() => onCreatePredecessor(t.id)} data-testid="fe4-detail-create-predecessor">
                ＋ 先行タスクを作成
                <span className={styles.childCreateHint}>このタスクの先行（依存元）として新規作成</span>
              </button>
            )}
          </div>
        )}

        {/* 添付（ファイル・URL）: upload/add, list, download/open, delete. */}
        <TaskAttachmentsEditor taskId={t.id} canWrite={canWrite} />

        {/* Leaf (no children) delete confirm — a ConfirmDialog modal (#375), unified with
            運営メンバー削除 etc. A parent-with-children NEVER reaches here — its 削除 fires
            onDeleteBlocked (bottom-right warning toast), never a confirm. */}
        <ConfirmDialog
          open={confirming}
          title="タスクを削除しますか？"
          message="このタスクを削除します。この操作は取り消せません。"
          confirmLabel="削除する"
          cancelLabel="やめる"
          danger
          onConfirm={onDelete}
          onCancel={() => setConfirming(false)}
          testId="fe4-confirm-delete"
        />
      </div>
    </Modal>
  );
}
