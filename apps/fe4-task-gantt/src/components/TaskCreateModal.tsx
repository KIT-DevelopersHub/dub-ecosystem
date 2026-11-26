import { useEffect, useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button } from "@dub/ui";
import { DraftRestoredNotice, useDraftAutosave, peekDraft } from "@dub/app-ui";
import { isoFromDateInput } from "../domain/task-form";
import { teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { rememberPredecessors } from "./PredecessorPicker";
import { TaskFormFields } from "./TaskFormFields";
import { encodeAssignee, hasAssignee, UNASSIGNED, type Assignee } from "../domain/assignee";
import styles from "../styles/app.module.css";

// P1-2 follow-up: unlike the edit-existing-task panel (TaskDetailPanel), which
// auto-saves straight to the server, a NEW task has nothing to persist to until
// 作成する is pressed — a reload mid-typing here silently dropped the whole form
// with no warning. Same @dub/app-ui draft-autosave/leave-guard pattern as
// mail compose (FE2) / role editor (FE7) / event edit (FE3): localStorage draft +
// beforeunload prompt + restore-on-return notice. This modal is mounted once and
// toggled via `open` (not remounted per open), so the draft is peeked at that one
// mount and the form is reset (which also clears the draft) on cancel/success —
// only an accidental reload/crash should ever trigger a restore.
const DRAFT_KEY = "fe4.task.create";

interface TaskCreateDraft {
  title: string;
  description: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  /** 担当チーム (#882). Exclusive with assigneeId. Optional for drafts saved before it existed. */
  assigneeTeamId?: common.TeamId | null;
  teamId: common.TeamId | null;
  start: string | null;
  due: string | null;
  parentId: common.TaskId | null;
  deps: common.TaskId[];
}

export interface TaskDraft {
  title: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  /** 担当チーム (#882). Exclusive with assigneeId. Optional for drafts saved before it existed. */
  assigneeTeamId?: common.TeamId | null;
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
  /** 担当の既定値 (担当は必須): ガントがチームで絞り込まれていればそのチーム、なければ作成者
   *  (domain/assignee defaultAssignee)。担当が空のときだけ入る。 */
  defaultAssignee?: Assignee;
}

// A newly-created task starts in "todo"; only todo-reachable states are offered.
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export function TaskCreateModal({ open, onClose, users, teams, parentOptions, scopeTasks, onCreate, initialDue, initialParentId, initialDependsOn, defaultAssignee = UNASSIGNED }: TaskCreateModalProps) {
  // Seed once from any draft left by an accidental reload; otherwise the usual blank form.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialDraft = useMemo(() => peekDraft<TaskCreateDraft>(DRAFT_KEY), []);
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [status, setStatus] = useState<task.TaskStatus>(initialDraft?.status ?? "todo");
  const [priority, setPriority] = useState<task.TaskPriority>(initialDraft?.priority ?? "medium");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(initialDraft?.assigneeId ?? null);
  const [assigneeTeamId, setAssigneeTeamId] = useState<common.TeamId | null>(initialDraft?.assigneeTeamId ?? null);
  const [teamId, setTeamId] = useState<common.TeamId | null>(initialDraft?.teamId ?? null);
  const [start, setStart] = useState<string | null>(initialDraft?.start ?? null);
  const [due, setDue] = useState<string | null>(initialDraft?.due ?? null);
  const [parentId, setParentId] = useState<common.TaskId | null>(initialDraft?.parentId ?? null);
  const [deps, setDeps] = useState<common.TaskId[]>(initialDraft?.deps ?? []);
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [saving, setSaving] = useState(false);

  // Dirty = there is something here worth keeping/warning about (blank-create baseline).
  const assigneeIsDefault = encodeAssignee({ assigneeId, assigneeTeamId }) === encodeAssignee(defaultAssignee);
  const dirty =
    title.trim() !== "" ||
    description.trim() !== "" ||
    status !== "todo" ||
    priority !== "medium" ||
    // the defaulted 担当 (and the team it derives) is not an edit worth a draft/leave-guard.
    (hasAssignee({ assigneeId, assigneeTeamId }) && !assigneeIsDefault) ||
    (teamId != null && !assigneeIsDefault) ||
    start != null ||
    due != null ||
    parentId != null ||
    deps.length > 0;
  const draft = useDraftAutosave<TaskCreateDraft>({
    storageKey: DRAFT_KEY,
    value: { title, description, status, priority, assigneeId, assigneeTeamId, teamId, start, due, parentId, deps },
    dirty,
  });

  // seed the due date + parent + predecessors when (re)opened (timeline cell /
  // "ここから子タスクを作成" preset the parent, etc.). 親をプリセットで開いたときは
  // チームも親のチームで固定する。
  //
  // A restored draft (peeked at mount, above) wins over a preset-less open — without
  // this guard, simply opening the modal via the plain "＋タスク作成" button (no
  // preset) would silently blank out a due/parent/predecessors restored after an
  // accidental reload, same as RoleEditorPage not letting `existing` clobber a
  // restored draft. An EXPLICIT preset (a timeline cell / "ここから子タスクを作成")
  // still always wins — that's a fresh, deliberate context the user just picked.
  useEffect(() => {
    if (!open) return;
    const hasExplicitPreset = initialDue != null || initialParentId != null || (initialDependsOn?.length ?? 0) > 0;
    if (draft.restoredVisible && !hasExplicitPreset) return;
    setDue(initialDue ?? null);
    const nextParent = initialParentId ?? null;
    setParentId(nextParent);
    if (nextParent) setTeamId(teamOf(scopeTasks, nextParent));
    setDeps(initialDependsOn ? [...initialDependsOn] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDue, initialParentId, initialDependsOn]);

  // 担当は必須: 担当が空のまま開いたら既定値 (チーム絞り込み中ならそのチーム・なければ本人) を入れる。
  // 復元した下書きの担当は上書きしない。チーム担当なら所属チームもそれに合わせる (親タスク指定時を除く)。
  const defaultKey = encodeAssignee(defaultAssignee);
  useEffect(() => {
    if (!open || hasAssignee({ assigneeId, assigneeTeamId }) || !hasAssignee(defaultAssignee)) return;
    setAssigneeId(defaultAssignee.assigneeId);
    setAssigneeTeamId(defaultAssignee.assigneeTeamId);
    if (defaultAssignee.assigneeTeamId && !parentId && !initialParentId) setTeamId(defaultAssignee.assigneeTeamId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultKey, assigneeId, assigneeTeamId]);

  const reset = () => {
    draft.clear(); // deliberate cancel/success — don't resurrect this as a "restored" draft later
    setTitle("");
    setStatus("todo");
    setPriority("medium");
    setAssigneeId(null);
    setAssigneeTeamId(null);
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

  // 担当は必須 (人 or チーム): タイトルと担当がそろうまで作成できない。
  const canSubmit = title.trim().length > 0 && hasAssignee({ assigneeId, assigneeTeamId });

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    try {
      const ok = await onCreate({
        title: title.trim(),
        status,
        priority,
        assigneeId,
        assigneeTeamId,
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
          <Button onClick={submit} loading={saving} disabled={!canSubmit} testId="fe4-create-submit">
            作成する
          </Button>
        </div>
      }
    >
      <DraftRestoredNotice
        visible={draft.restoredVisible}
        onDiscard={reset}
        onKeep={draft.acknowledgeRestored}
        testId="fe4-create-draft-notice"
      />
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
        assigneeTeamId={assigneeTeamId}
        onAssigneeTeamIdChange={setAssigneeTeamId}
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
