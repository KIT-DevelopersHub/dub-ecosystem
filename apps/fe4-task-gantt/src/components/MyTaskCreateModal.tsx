import { useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button } from "@dub/ui";
import { isoFromDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import {
  TaskComposeFields,
  useAttachmentDraft,
  MAX_ATTACHMENT_BYTES,
  type DraftAttachments,
  type DraftFileAttachment,
  type DraftUrlAttachment,
} from "./TaskComposeFields";
import styles from "../styles/app.module.css";

// Re-export the attachment types from their new shared home so existing importers
// keep working.
export type { DraftAttachments, DraftFileAttachment, DraftUrlAttachment };
export { MAX_ATTACHMENT_BYTES };

export interface MyTaskDraft {
  /** Optional event link (判断44). null = issue the task unlinked to any event. */
  eventId: common.EventId | null;
  title: string;
  description: string | null;
  /** ③ ステータス — 共通化で発行モーダルでも選べる（既定=todo）。 */
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  /** ③ 開始日 — 共通化で発行モーダルでも設定可（省略=null）。 */
  startAt: common.ISODateTime | null;
  /** WBS 親タスク（親子関係）. null ⇒ トップレベル（親なし）. 子は親と同じチームに固定される。 */
  parentId: common.TaskId | null;
  /** 先行タスク（依存＝この新規タスクが待つタスク）. 同じ親スコープ内のタスクのみ。 */
  dependsOnIds: common.TaskId[];
  dueAt: common.ISODateTime | null;
  attachments: DraftAttachments;
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
  onCreate: (draft: MyTaskDraft) => Promise<void>;
  /** preselect the requester's own name in the header hint. */
  requesterName?: string;
  /** ③ 先行タスク・親タスクを選ぶための候補（`scopeEventId` イベントのタスク一覧・チーム情報つき）。 */
  scopeTasks?: readonly ScopeTask[];
  /** `scopeTasks` が属する対象イベント。選択中の対象イベントがこれと一致するときだけ関係欄を出す。 */
  scopeEventId?: common.EventId | null;
  /** 対象イベントが変わったら親（呼び出し側）へ通知する。 */
  onEventChange?: (eventId: common.EventId | null) => void;
}

const NO_EVENT = ""; // sentinel for the "未紐付け" Select option

/**
 * "タスクを発行" — anyone can add and issue a task (design ask (a)). The form body is
 * now the shared `TaskComposeFields` (③ 判断99: 作成/発行モーダルの完全共通化)。対象
 * イベントの紐付けは任意（判断44）。
 */
export function MyTaskCreateModal({
  open,
  onClose,
  events,
  people,
  teams,
  onCreate,
  requesterName,
  scopeTasks,
  scopeEventId = null,
  onEventChange,
}: MyTaskCreateModalProps) {
  const [eventId, setEventId] = useState<common.EventId | "">(NO_EVENT);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [parentId, setParentId] = useState<common.TaskId | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [start, setStart] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const attach = useAttachmentDraft();
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEventId(NO_EVENT);
    setTitle("");
    setAssigneeId(null);
    setStatus("todo");
    setPriority("medium");
    setTeamId(null);
    setParentId(null);
    setDeps([]);
    setStart(null);
    setDue(null);
    setDescription("");
    attach.reset();
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  // ③ 親タスク・先行タスク（親子/依存）を選ぶための候補とロック状態を導出する。
  const scope = scopeTasks ?? [];
  const selectedEventId: common.EventId | null = eventId === NO_EVENT ? null : (eventId as common.EventId);
  // 別イベントの親子・依存を作らせない: 選択中の対象イベントが候補の属するイベント(scopeEventId)と
  // 一致するときだけ関係欄を出す。
  const scopeMatchesEvent = selectedEventId != null && selectedEventId === scopeEventId;
  const showRelationFields = scope.length > 0 && scopeMatchesEvent;
  const teamLockedToParent = parentId != null;
  const depOptions = dependencyScopeOptions(scope, parentId);
  const parentOptions = scope.map((s) => ({ id: s.id, title: s.title }));

  const onChangeParent = (next: common.TaskId | null) => {
    setParentId(next);
    setDeps((d) => pruneToScope(scope, next, d).filter((id) => id !== next));
    if (next) setTeamId(teamOf(scope, next));
  };
  const onChangeEvent = (next: common.EventId | "") => {
    setEventId(next);
    setParentId(null);
    setDeps([]);
    onEventChange?.(next === NO_EVENT ? null : (next as common.EventId));
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
        teamId: teamLockedToParent ? teamOf(scope, parentId) : teamId,
        startAt: isoFromDateInput(start),
        parentId: showRelationFields ? parentId : null,
        dependsOnIds: showRelationFields ? deps : [],
        dueAt: isoFromDateInput(due),
        attachments: { files: [...attach.files], urls: [...attach.urls] },
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
      <TaskComposeFields
        idPrefix="fe4-mytask"
        testIdPrefix="fe4-mytask-create"
        title={title}
        onTitle={setTitle}
        titlePlaceholder="例: 登壇者へ最終案内メールを送る"
        eventMode="select"
        eventValue={eventId}
        eventOptions={events}
        onEvent={onChangeEvent}
        status={status}
        onStatus={setStatus}
        priority={priority}
        onPriority={setPriority}
        people={people}
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
        showRelations={showRelationFields}
        parentId={parentId}
        onParent={onChangeParent}
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
