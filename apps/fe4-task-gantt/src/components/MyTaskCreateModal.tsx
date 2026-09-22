import { useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button } from "@dub/ui";
import { DraftRestoredNotice, useDraftAutosave, peekDraft } from "@dub/app-ui";
import { isoFromDateInput } from "../domain/task-form";
import { type ScopeTask } from "../domain/task-hierarchy";
import { TaskFormFields } from "./TaskFormFields";
import styles from "../styles/app.module.css";

// P1-2 follow-up — same draft-autosave/leave-guard as TaskCreateModal (the gantt
// タスク作成 form). Separate storage key: this is "タスク発行" (マイタスク), a distinct
// form with no event/parent/dep presets to reconcile.
const DRAFT_KEY = "fe4.mytask.create";

interface MyTaskCreateDraft {
  title: string;
  description: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  start: string | null;
  due: string | null;
  parentId: common.TaskId | null;
  deps: common.TaskId[];
}

export interface MyTaskDraft {
  /** Event link — resolved from CONTEXT, never a visible field (判断44). The gantt
   *  タスク作成 stamps its eventId from the route; マイタスク has no event context so
   *  this defaults to null (unlinked). Both forms therefore show the SAME fields. */
  eventId: common.EventId | null;
  title: string;
  description: string | null;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  /** Planned start (開始日). null = no explicit start. Mirrors the gantt create form. */
  startAt: common.ISODateTime | null;
  /** 終了日 (canonical field is `dueAt`; 期日=終了日として扱う). */
  dueAt: common.ISODateTime | null;
  /** WBS parent (親タスク). null = top-level. */
  parentTaskId: common.TaskId | null;
  /** 先行タスク (依存・同じチーム内). */
  dependsOnIds: common.TaskId[];
}

export interface MyTaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  people: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks offered as WBS parents (親タスク). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  /** existing tasks with their team — powers the team-scoped 先行タスク picker. */
  scopeTasks: readonly ScopeTask[];
  onCreate: (draft: MyTaskDraft) => Promise<void>;
  /** preselect the requester's own name in the header hint. */
  requesterName?: string;
  /** Event link resolved from context (現在開いているイベント/ビュー). The マイタスク hub
   *  is cross-event, so it has no current event → null (=未紐付け・判断44で許容). Not a
   *  visible field: keeps this form 寸分違わず同一 with the gantt タスク作成. */
  defaultEventId?: common.EventId | null;
}

// A newly-issued task starts in "todo"; only todo-reachable states are offered (同 ガント作成).
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

/**
 * "タスクを発行" — anyone can add and issue a task (design ask (a)). Renders the SAME
 * canonical field set/layout as the gantt タスク作成フォーム by delegating to the shared
 * TaskFormFields with the SAME props (no form-specific extra rows: 対象イベント/添付 は撤去済み).
 * イベント紐付けはコンテキストで解決し (defaultEventId)、UI には出さない。The requester
 * (from) is the current user, stamped server-side as created_by.
 */
export function MyTaskCreateModal({ open, onClose, people, teams, parentOptions, scopeTasks, onCreate, requesterName, defaultEventId = null }: MyTaskCreateModalProps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialDraft = useMemo(() => peekDraft<MyTaskCreateDraft>(DRAFT_KEY), []);
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [status, setStatus] = useState<task.TaskStatus>(initialDraft?.status ?? "todo");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(initialDraft?.assigneeId ?? null);
  const [priority, setPriority] = useState<task.TaskPriority>(initialDraft?.priority ?? "medium");
  const [teamId, setTeamId] = useState<common.TeamId | null>(initialDraft?.teamId ?? null);
  const [start, setStart] = useState<string | null>(initialDraft?.start ?? null);
  const [due, setDue] = useState<string | null>(initialDraft?.due ?? null);
  const [parentId, setParentId] = useState<common.TaskId | null>(initialDraft?.parentId ?? null);
  const [deps, setDeps] = useState<common.TaskId[]>(initialDraft?.deps ?? []);
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [saving, setSaving] = useState(false);

  const dirty =
    title.trim() !== "" ||
    description.trim() !== "" ||
    status !== "todo" ||
    priority !== "medium" ||
    assigneeId != null ||
    teamId != null ||
    start != null ||
    due != null ||
    parentId != null ||
    deps.length > 0;
  const draft = useDraftAutosave<MyTaskCreateDraft>({
    storageKey: DRAFT_KEY,
    value: { title, description, status, priority, assigneeId, teamId, start, due, parentId, deps },
    dirty,
  });

  const reset = () => {
    draft.clear(); // deliberate cancel/success — don't resurrect this as a "restored" draft later
    setTitle("");
    setStatus("todo");
    setAssigneeId(null);
    setPriority("medium");
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

  // Only the title gates submission (event link comes from context, not the form).
  const canSubmit = title.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onCreate({
        eventId: defaultEventId,
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        status,
        priority,
        assigneeId,
        teamId,
        startAt: isoFromDateInput(start),
        dueAt: isoFromDateInput(due),
        parentTaskId: parentId,
        dependsOnIds: deps,
      });
      reset();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="タスクを発行"
      testId="fe4-mytask-create-modal"
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" onClick={close} testId="fe4-mytask-create-cancel">
            キャンセル
          </Button>
          <Button onClick={submit} loading={saving} disabled={!canSubmit} testId="fe4-mytask-create-submit">
            発行する
          </Button>
        </div>
      }
    >
      {requesterName && (
        <p className={styles.createHint} data-testid="fe4-mytask-create-from">
          依頼主: <strong>{requesterName}</strong>
        </p>
      )}
      <DraftRestoredNotice
        visible={draft.restoredVisible}
        onDiscard={reset}
        onKeep={draft.acknowledgeRestored}
        testId="fe4-mytask-create-draft-notice"
      />
      <TaskFormFields
        idPrefix="fe4-mytask-create"
        title={title}
        onTitleChange={setTitle}
        titlePlaceholder="例: 登壇者へ最終案内メールを送る"
        statuses={CREATE_STATUSES}
        status={status}
        onStatusChange={setStatus}
        priorities={PRIORITIES}
        priority={priority}
        onPriorityChange={setPriority}
        users={people}
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
        descriptionPlaceholder="依頼の詳細や補足を書けます"
      />
    </Modal>
  );
}
