import { useEffect, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button } from "@dub/ui";
import { isoFromDateInput } from "../domain/task-form";
import { teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { rememberPredecessors } from "./PredecessorPicker";
import { TaskFormFields } from "./TaskFormFields";
import styles from "../styles/app.module.css";

export interface TaskDraft {
  title: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  startAt: common.ISODateTime | null;
  dueAt: common.ISODateTime | null;
  /** WBS parent (親タスク). null = top-level. Chosen before the predecessors. */
  parentTaskId: common.TaskId | null;
  dependsOnIds: common.TaskId[];
  /** 詳細 (long-form note). null = empty. */
  description: string | null;
}

export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  users: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks in the event, offered as WBS parents (親タスク). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  /** every task in the event with its team — predecessors are scoped to the chosen
   *  team (ADR-0007: 同一チーム内なら別スコープ/別階層も依存可・別チームは不可). */
  scopeTasks: readonly ScopeTask[];
  /** Resolves `false` when the task was NOT created (keep the modal open so the
   *  user can fix + retry); `true`/void on success (modal closes). */
  onCreate: (draft: TaskDraft) => Promise<boolean | void>;
  /** date-input value (YYYY-MM-DD) preset when opened from a timeline cell. */
  initialDue?: string | null;
  /** parent id preset when opened via "ここから子タスクを作成". */
  initialParentId?: common.TaskId | null;
  /** predecessor ids preset when opened with a dependency already in mind. */
  initialDependsOn?: readonly common.TaskId[];
}

// A newly-created task starts in "todo"; only todo-reachable states are offered.
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export function TaskCreateModal({ open, onClose, users, teams, parentOptions, scopeTasks, onCreate, initialDue, initialParentId, initialDependsOn }: TaskCreateModalProps) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [parentId, setParentId] = useState<common.TaskId | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // seed the due date + parent + predecessors when (re)opened (timeline cell /
  // "ここから子タスクを作成" preset the parent, etc.). 親をプリセットで開いたときは
  // チームも親のチームで固定する。
  useEffect(() => {
    if (open) {
      setDue(initialDue ?? null);
      const nextParent = initialParentId ?? null;
      setParentId(nextParent);
      if (nextParent) setTeamId(teamOf(scopeTasks, nextParent));
      setDeps(initialDependsOn ? [...initialDependsOn] : []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDue, initialParentId, initialDependsOn]);

  const reset = () => {
    setTitle("");
    setStatus("todo");
    setPriority("medium");
    setAssigneeId(null);
    setTeamId(null);
    setStart(null);
    setDue(null);
    setParentId(null);
    setDeps([]);
    setDescription("");
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const ok = await onCreate({
        title: title.trim(),
        status,
        priority,
        assigneeId,
        // 子タスク作成時はチームを親に固定（UIは disabled だが念のため送信値も親で確定）。
        teamId: parentId ? teamOf(scopeTasks, parentId) : teamId,
        startAt: isoFromDateInput(start),
        dueAt: isoFromDateInput(due),
        parentTaskId: parentId,
        dependsOnIds: deps,
        description: description.trim() ? description.trim() : null,
      });
      // Close ONLY on success — a failed create keeps the form (with its input) open
      // so the user can retry after reading the error dialog. Success shows a toast.
      if (ok !== false) {
        rememberPredecessors(deps);
        reset();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="タスクを作成"
      testId="fe4-create-modal"
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" onClick={close} testId="fe4-create-cancel">
            キャンセル
          </Button>
          <Button onClick={submit} loading={saving} disabled={!title.trim()} testId="fe4-create-submit">
            作成する
          </Button>
        </div>
      }
    >
      <TaskFormFields
        idPrefix="fe4-create"
        title={title}
        onTitleChange={setTitle}
        titlePlaceholder="例: 会場の最終確認"
        statuses={CREATE_STATUSES}
        status={status}
        onStatusChange={setStatus}
        priorities={PRIORITIES}
        priority={priority}
        onPriorityChange={setPriority}
        users={users}
        assigneeId={assigneeId}
        onAssigneeChange={setAssigneeId}
        teams={teams}
        teamId={teamId}
        onTeamIdChange={setTeamId}
        start={start}
        onStartChange={setStart}
        due={due}
        onDueChange={setDue}
        scopeTasks={scopeTasks}
        parentOptions={parentOptions}
        parentId={parentId}
        onParentIdChange={setParentId}
        deps={deps}
        onDepsChange={setDeps}
        description={description}
        onDescriptionChange={setDescription}
        descriptionPlaceholder="タスクの詳細や補足を書けます"
      />
    </Modal>
  );
}
