import { useEffect, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Textarea, Select } from "@dub/ui";
import { PRIORITY_LABEL, isoFromDateInput } from "../domain/task-form";
import { DateField } from "./DateField";
import { AttachmentField, type AttachmentChip } from "./AttachmentField";
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
  /** null = 優先度未設定 — the requester left it blank. The server defaults an
   *  omitted priority to "medium" (CreateTaskRequest contract); both the マイタスク
   *  list and the ガント read that same resulting task, so the two views stay in
   *  sync. Kept nullable here (not in @dub/types) so the initial value can be blank
   *  without touching the shared Task contract. */
  priority: task.TaskPriority | null;
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
  /** 対象イベントの初期値 — the event currently selected in the global header
   *  (グローバルなイベント選択状態). Each time the modal opens it seeds 対象イベント
   *  to this (when it is one of `events`); the requester can still change it. Null /
   *  unknown ⇒ start unlinked (「紐付けない」). */
  defaultEventId?: common.EventId | null;
  /** チームの初期値 — the team the logged-in requester belongs to (名簿より解決). Each time
   *  the modal opens it seeds チーム to this (when it is one of `teams`); the requester can
   *  still change it. Null / unknown ⇒ start 未割当. */
  defaultTeamId?: common.TeamId | null;
}

const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

/**
 * "タスクを発行" — anyone can add and issue a task (design ask (a)). The modal
 * captures 誰に(担当者)・内容・期限. Linking the task to an 対象イベント is now
 * OPTIONAL (判断44): leave it as「紐付けない」to issue a standalone task. The
 * requester (from) is the current user, stamped server-side as created_by — so no
 * field is needed for it.
 */
const NO_EVENT = ""; // sentinel for the "未紐付け" Select option
const NO_PRIORITY = ""; // sentinel for the "未設定" priority Select option

export function MyTaskCreateModal({ open, onClose, events, people, teams, onCreate, requesterName, defaultEventId, defaultTeamId }: MyTaskCreateModalProps) {
  // The header-selected event is the initial 対象イベント, but only when it is a real
  // option in `events` (guards against a stale/foreign id) — otherwise start unlinked.
  const seedEventId = (): common.EventId | "" =>
    defaultEventId && events.some((e) => e.id === defaultEventId) ? defaultEventId : NO_EVENT;
  // The requester's own team is the initial チーム, but only when it is a real option in
  // `teams` (guards against a stale/foreign id) — otherwise start 未割当.
  const seedTeamId = (): common.TeamId | null =>
    defaultTeamId && teams.some((t) => t.id === defaultTeamId) ? defaultTeamId : null;

  const [eventId, setEventId] = useState<common.EventId | "">(seedEventId);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [priority, setPriority] = useState<task.TaskPriority | "">(NO_PRIORITY);
  const [teamId, setTeamId] = useState<common.TeamId | null>(seedTeamId);
  const [due, setDue] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<DraftFileAttachment[]>([]);
  const [urls, setUrls] = useState<DraftUrlAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed 対象イベント / チーム to the current defaults each time the modal opens, so they
  // reflect the latest グローバルなイベント選択状態 / the requester's team (which resolves from
  // the 名簿 asynchronously — re-seed on defaultTeamId/teams too so it lands once available).
  // The user can still change them. Only these two seeded fields are re-seeded; the rest keeps
  // its state.
  useEffect(() => {
    if (open) {
      setEventId(seedEventId());
      setTeamId(seedTeamId());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultEventId, defaultTeamId, teams]);

  const reset = () => {
    setEventId(seedEventId());
    setTitle("");
    setAssigneeId(null);
    setPriority(NO_PRIORITY);
    setTeamId(seedTeamId());
    setDue(null);
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
        priority: priority === NO_PRIORITY ? null : (priority as task.TaskPriority),
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
            対象イベント（任意）
          </label>
          <Select
            id="fe4-mytask-event"
            value={eventId}
            onChange={(v) => setEventId(v as common.EventId | "")}
            options={[
              { value: NO_EVENT, label: "紐付けない" },
              ...events.map((e) => ({ value: e.id, label: e.name })),
            ]}
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
            onChange={(v) => setPriority(v as task.TaskPriority | "")}
            options={[
              { value: NO_PRIORITY, label: "未設定" },
              ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
            ]}
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

        {/* 添付（ファイル・URL）: shared compact 📎/🔗 control — same look as the gantt
            タスク詳細 (③=②で統一・共通コンポーネント化). */}
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

        {/* 詳細（任意・旧「内容」）: long-form note last, mirroring the タスク詳細 order. */}
        <div className={styles.formFieldFull}>
          <label className={styles.formLabel} htmlFor="fe4-mytask-desc">
            詳細（任意）
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
    </Modal>
  );
}
