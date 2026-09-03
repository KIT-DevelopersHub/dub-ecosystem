import { useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, Select } from "@dub/ui";
import { isoFromDateInput } from "../domain/task-form";
import { type ScopeTask } from "../domain/task-hierarchy";
import { AttachmentField, type AttachmentChip } from "./AttachmentField";
import { TaskFormFields } from "./TaskFormFields";
import styles from "../styles/app.module.css";

/** A file the requester attached in the modal — read into a self-contained data:
 *  URL (minimal impl; a file-meta/R2 blob upload is a documented follow-up). */
export interface DraftFileAttachment {
  name: string;
  url: string; // data: URL
  mimeType: string;
  sizeBytes: number;
}
export interface DraftUrlAttachment {
  name: string;
  url: string;
}
export interface DraftAttachments {
  files: DraftFileAttachment[];
  urls: DraftUrlAttachment[];
}

export interface MyTaskDraft {
  /** Optional event link (判断44). null = issue the task unlinked to any event. */
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
  attachments: DraftAttachments;
}

/** Per-file cap for the data-URL (meta+URL minimal impl) attachment path. */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024; // 1 MB

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

export interface EventOption {
  id: common.EventId;
  name: string;
}

export interface MyTaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  events: readonly EventOption[];
  people: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks offered as WBS parents (親タスク). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  /** existing tasks with their team — powers the team-scoped 先行タスク picker. */
  scopeTasks: readonly ScopeTask[];
  onCreate: (draft: MyTaskDraft) => Promise<void>;
  /** preselect the requester's own name in the header hint. */
  requesterName?: string;
}

// A newly-issued task starts in "todo"; only todo-reachable states are offered (同 ガント作成).
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

/**
 * "タスクを発行" — anyone can add and issue a task (design ask (a)). Uses the SAME
 * canonical field set/layout as the gantt タスク作成フォーム (共通コンポーネント
 * TaskFormFields), with two form-specific extras: an optional 対象イベント link
 * (判断44) above the shared fields, and 添付 (attachments) just before 詳細. The
 * requester (from) is the current user, stamped server-side as created_by.
 */
const NO_EVENT = ""; // sentinel for the "未紐付け" Select option

export function MyTaskCreateModal({ open, onClose, events, people, teams, parentOptions, scopeTasks, onCreate, requesterName }: MyTaskCreateModalProps) {
  const [eventId, setEventId] = useState<common.EventId | "">(NO_EVENT);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [parentId, setParentId] = useState<common.TaskId | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<DraftFileAttachment[]>([]);
  const [urls, setUrls] = useState<DraftUrlAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEventId(NO_EVENT);
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
    setFiles([]);
    setUrls([]);
    setAttachError(null);
  };

  const onPickFiles = async (list: FileList) => {
    setAttachError(null);
    const added: DraftFileAttachment[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(`「${file.name}」は1MBを超えています（添付できるのは1MBまで）`);
        continue;
      }
      const url = await readFileAsDataUrl(file);
      added.push({ name: file.name, url, mimeType: file.type || "application/octet-stream", sizeBytes: file.size });
    }
    if (added.length > 0) setFiles((prev) => [...prev, ...added]);
  };

  const addUrl = (url: string, name: string) => {
    setAttachError(null);
    setUrls((prev) => [...prev, { url, name: name || url }]);
  };

  // Draft attachments as compact chips (no href — the task doesn't exist yet, so there's
  // nothing to open/download until it's issued). Stable ids encode kind+index for removal.
  const attachChips: AttachmentChip[] = [
    ...files.map((f, i): AttachmentChip => ({ id: `f${i}`, kind: "file", name: f.name, sizeBytes: f.sizeBytes })),
    ...urls.map((u, i): AttachmentChip => ({ id: `u${i}`, kind: "url", name: u.name })),
  ];
  const removeChip = (id: string) => {
    const i = Number(id.slice(1));
    if (id.startsWith("f")) setFiles((prev) => prev.filter((_, j) => j !== i));
    else if (id.startsWith("u")) setUrls((prev) => prev.filter((_, j) => j !== i));
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  // Event link is optional now — only the title gates submission.
  const canSubmit = title.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onCreate({
        eventId: eventId === NO_EVENT ? null : (eventId as common.EventId),
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
        attachments: { files, urls },
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
        assigneeLabel="依頼先（担当者）"
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
        leadingSlot={
          <div className={styles.formFieldFull}>
            <label className={styles.formLabel} htmlFor="fe4-mytask-create-event">
              対象イベント（任意）
            </label>
            <Select
              id="fe4-mytask-create-event"
              value={eventId}
              onChange={(v) => setEventId(v as common.EventId | "")}
              options={[
                { value: NO_EVENT, label: "紐付けない" },
                ...events.map((e) => ({ value: e.id, label: e.name })),
              ]}
              testId="fe4-mytask-create-event"
            />
          </div>
        }
        beforeDescriptionSlot={
          <div className={styles.formFieldFull}>
            <AttachmentField
              chips={attachChips}
              canWrite
              busy={saving}
              error={attachError}
              onPickFiles={(list) => void onPickFiles(list)}
              onAddUrl={addUrl}
              onRemove={removeChip}
              testIdPrefix="fe4-mytask-attach"
            />
          </div>
        }
      />
    </Modal>
  );
}
