import { useEffect, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Textarea, Select } from "@dub/ui";
import { PRIORITY_LABEL, isoFromDateInput } from "../domain/task-form";
import { DateField } from "./DateField";
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
  eventId: common.EventId;
  title: string;
  description: string | null;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  dueAt: common.ISODateTime | null;
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
  const [files, setFiles] = useState<DraftFileAttachment[]>([]);
  const [urls, setUrls] = useState<DraftUrlAttachment[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlName, setUrlName] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
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
    setFiles([]);
    setUrls([]);
    setUrlInput("");
    setUrlName("");
    setAttachError(null);
  };

  const onPickFiles = async (list: FileList | null) => {
    if (!list) return;
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

  const addUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setAttachError("URLは http(s):// から始めてください");
      return;
    }
    setAttachError(null);
    setUrls((prev) => [...prev, { url, name: urlName.trim() || url }]);
    setUrlInput("");
    setUrlName("");
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const canSubmit = title.trim().length > 0 && eventId !== "" && !saving;

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

        <div className={styles.formFieldFull}>
          <label className={styles.formLabel}>添付（ファイル・URL）</label>
          <div className={styles.attachRow}>
            <input
              type="file"
              multiple
              className={styles.attachFileInput}
              onChange={(e) => {
                void onPickFiles(e.target.files);
                e.target.value = "";
              }}
              data-testid="fe4-mytask-create-file"
              aria-label="ファイルを添付"
            />
          </div>
          <div className={styles.attachUrlRow}>
            <TextField
              id="fe4-mytask-url-name"
              value={urlName}
              onChange={setUrlName}
              placeholder="表示名（任意）"
              testId="fe4-mytask-create-url-name"
            />
            <TextField
              id="fe4-mytask-url"
              value={urlInput}
              onChange={setUrlInput}
              placeholder="https://example.com/..."
              testId="fe4-mytask-create-url"
            />
            <Button variant="ghost" onClick={addUrl} disabled={!urlInput.trim()} testId="fe4-mytask-create-url-add">
              URLを追加
            </Button>
          </div>
          {attachError && (
            <p className={styles.attachError} data-testid="fe4-mytask-create-attach-error">
              {attachError}
            </p>
          )}
          {(files.length > 0 || urls.length > 0) && (
            <ul className={styles.attachDraftList} data-testid="fe4-mytask-create-attach-list">
              {files.map((f, i) => (
                <li key={`f-${i}`} className={styles.attachDraftItem}>
                  <span className={styles.attachDraftName}>📎 {f.name}</span>
                  <button
                    type="button"
                    className={styles.attachDraftRemove}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`${f.name} を外す`}
                  >
                    ×
                  </button>
                </li>
              ))}
              {urls.map((u, i) => (
                <li key={`u-${i}`} className={styles.attachDraftItem}>
                  <span className={styles.attachDraftName}>🔗 {u.name}</span>
                  <button
                    type="button"
                    className={styles.attachDraftRemove}
                    onClick={() => setUrls((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`${u.name} を外す`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
