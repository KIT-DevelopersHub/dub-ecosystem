import { useEffect, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Textarea, Select } from "@dub/ui";
import { PRIORITY_LABEL, isoFromDateInput } from "../domain/task-form";
import { DateField } from "./DateField";
import styles from "../styles/app.module.css";

export interface MyTaskDraft {
  eventId: common.EventId;
  title: string;
  description: string | null;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  dueAt: common.ISODateTime | null;
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
}

const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

/**
 * "タスクを発行" — anyone can add and issue a task (design ask (a)). The modal
 * captures 誰に(担当者)・内容・期限, plus the 対象イベント the task belongs to
 * (task-service requires a live eventId). The requester (from) is the current
 * user, stamped server-side as created_by — so no field is needed for it.
 */
export function MyTaskCreateModal({ open, onClose, events, people, teams, onCreate, requesterName }: MyTaskCreateModalProps) {
  const [eventId, setEventId] = useState<common.EventId | "">(events[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setEventId((prev) => prev || events[0]?.id || "");
  }, [open, events]);

  const reset = () => {
    setTitle("");
    setAssigneeId(null);
    setPriority("medium");
    setTeamId(null);
    setDue(null);
    setDescription("");
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  // task-service requires a live eventId, so a task cannot be issued when the org
  // has no events yet. Rather than a disabled dead-end, the modal switches to an
  // empty state that explains why and links to イベント作成 (owned by FE3 /events).
  const noEvents = events.length === 0;
  const canSubmit = title.trim().length > 0 && eventId !== "" && !saving;

  const goCreateEvent = () => {
    if (typeof window !== "undefined") window.location.assign("/events");
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onCreate({
        eventId: eventId as common.EventId,
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        priority,
        assigneeId,
        teamId,
        dueAt: isoFromDateInput(due),
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
          {noEvents ? (
            <Button onClick={goCreateEvent} testId="fe4-mytask-create-go-event">
              イベントを作成
            </Button>
          ) : (
            <Button onClick={submit} loading={saving} disabled={!canSubmit} testId="fe4-mytask-create-submit">
              発行する
            </Button>
          )}
        </div>
      }
    >
      {noEvents ? (
        <div className={styles.createHint} data-testid="fe4-mytask-create-no-events">
          <p>
            タスクは必ず<strong>イベント</strong>に紐づきます。対象にできるイベントがまだ無いため、
            先にイベントを作成してください。
          </p>
          <p>
            「イベントを作成」を押すとイベント一覧へ移動します。作成後、ここに戻って
            タスクを発行できます。
          </p>
        </div>
      ) : (
      <>
      {requesterName && (
        <p className={styles.createHint} data-testid="fe4-mytask-create-from">
          依頼主: <strong>{requesterName}</strong>
        </p>
      )}
      <div className={styles.formGrid}>
        <div className={styles.formFieldFull}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-title">
            タイトル<span className={styles.req}>*</span>
          </label>
          <TextField
            id="fe4-mytask-title"
            value={title}
            onChange={setTitle}
            placeholder="例: 登壇者へ最終案内メールを送る"
            testId="fe4-mytask-create-title"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-event">
            対象イベント<span className={styles.req}>*</span>
          </label>
          <Select
            id="fe4-mytask-event"
            value={eventId}
            onChange={(v) => setEventId(v as common.EventId)}
            options={events.map((e) => ({ value: e.id, label: e.name }))}
            placeholder="イベントを選択"
            testId="fe4-mytask-create-event"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-assignee">
            依頼先（担当者）
          </label>
          <Select
            id="fe4-mytask-assignee"
            value={assigneeId ?? ""}
            onChange={(v) => setAssigneeId(v ? (v as common.UserId) : null)}
            options={[{ value: "", label: "未割当" }, ...people.map((u) => ({ value: u.id, label: u.displayName }))]}
            testId="fe4-mytask-create-assignee"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-priority">
            優先度
          </label>
          <Select
            id="fe4-mytask-priority"
            value={priority}
            onChange={(v) => setPriority(v as task.TaskPriority)}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            testId="fe4-mytask-create-priority"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-due">
            期限
          </label>
          <DateField id="fe4-mytask-due" value={due} onChange={setDue} testId="fe4-mytask-create-due" />
        </div>

        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-mytask-team">
              チーム
            </label>
            <Select
              id="fe4-mytask-team"
              value={teamId ?? ""}
              onChange={(v) => setTeamId(v ? (v as common.TeamId) : null)}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId="fe4-mytask-create-team"
            />
          </div>
        )}

        <div className={styles.formFieldFull}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-desc">
            内容（任意）
          </label>
          <Textarea
            id="fe4-mytask-desc"
            value={description}
            onChange={setDescription}
            rows={3}
            placeholder="依頼の詳細や補足を書けます"
            testId="fe4-mytask-create-desc"
          />
        </div>
      </div>
      </>
      )}
    </Modal>
  );
}
