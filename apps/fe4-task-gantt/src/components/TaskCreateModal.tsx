import { useEffect, useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button } from "@dub/ui";
import { isoFromDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import {
  TaskComposeFields,
  useAttachmentDraft,
  type DraftAttachments,
} from "./TaskComposeFields";
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
  /** ③ 内容（説明）— 共通化でガントでも入力可（省略=null）。 */
  description: string | null;
  /** ③ 添付（ファイル・URL）— 共通化でガントでも添付可（作成後に永続化）。 */
  attachments: DraftAttachments;
}

export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  users: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks in the event, offered as WBS parents (親タスク). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  /** every task in the event with its direct parent — predecessors are scoped to
   *  the chosen parent's siblings (判断10: 同一直接親のみ依存可). */
  scopeTasks: readonly ScopeTask[];
  /** The event this gantt is bound to — shown (locked) as 対象イベント for parity with
   *  the 発行 modal. Optional name for a readable label. */
  eventId: common.EventId;
  eventName?: string;
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

export function TaskCreateModal({
  open,
  onClose,
  users,
  teams,
  parentOptions,
  scopeTasks,
  eventId,
  eventName,
  onCreate,
  initialDue,
  initialParentId,
  initialDependsOn,
}: TaskCreateModalProps) {
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
  const attach = useAttachmentDraft();
  const [saving, setSaving] = useState(false);

  // Predecessors are scoped to the chosen parent's siblings (判断10). Recomputes
  // whenever the parent changes so the picker only offers same-scope tasks.
  const depOptions = useMemo(() => dependencyScopeOptions(scopeTasks, parentId), [scopeTasks, parentId]);

  // 親子は同一チーム: 親を選んだ子タスクは親のチームに固定する。
  const teamLockedToParent = parentId != null;

  // seed the due date + parent + predecessors when (re)opened.
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
    attach.reset();
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
        // 子タスク作成時はチームを親に固定（UIは disabled だが送信値も親で確定）。
        teamId: parentId ? teamOf(scopeTasks, parentId) : teamId,
        startAt: isoFromDateInput(start),
        dueAt: isoFromDateInput(due),
        parentTaskId: parentId,
        dependsOnIds: deps,
        description: description.trim() ? description.trim() : null,
        attachments: { files: [...attach.files], urls: [...attach.urls] },
      });
      // Close ONLY on success — a failed create keeps the form (with its input) open.
      if (ok !== false) {
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
      <TaskComposeFields
        idPrefix="fe4-create"
        testIdPrefix="fe4-create"
        title={title}
        onTitle={setTitle}
        titlePlaceholder="例: 会場の最終確認"
        eventMode="locked"
        eventValue={eventId}
        eventOptions={eventName ? [{ id: eventId, name: eventName }] : [{ id: eventId, name: "このイベント" }]}
        status={status}
        onStatus={setStatus}
        priority={priority}
        onPriority={setPriority}
        people={users}
        assigneeId={assigneeId}
        onAssignee={setAssigneeId}
        start={start}
        onStart={setStart}
        due={due}
        onDue={setDue}
        teams={teams}
        teamId={teamId}
        onTeam={setTeamId}
        teamLocked={teamLockedToParent}
        showRelations
        parentId={parentId}
        onParent={(next) => {
          setParentId(next);
          // dependencies must stay within the new scope — drop the out-of-scope ones.
          setDeps((d) => pruneToScope(scopeTasks, next, d));
          if (next) setTeamId(teamOf(scopeTasks, next));
        }}
        parentOptions={parentOptions}
        deps={deps}
        onDeps={setDeps}
        depOptions={depOptions}
        description={description}
        onDescription={setDescription}
        files={attach.files}
        urls={attach.urls}
        urlInput={attach.urlInput}
        urlName={attach.urlName}
        attachError={attach.attachError}
        onUrlInput={attach.setUrlInput}
        onUrlName={attach.setUrlName}
        onPickFiles={attach.onPickFiles}
        onAddUrl={attach.addUrl}
        onRemoveFile={attach.removeFile}
        onRemoveUrl={attach.removeUrl}
      />
    </Modal>
  );
}
