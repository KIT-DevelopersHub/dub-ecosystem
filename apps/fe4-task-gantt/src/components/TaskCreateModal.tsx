import { useEffect, useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Textarea, Select } from "@dub/ui";
import { PRIORITY_LABEL, STATUS_LABEL, isoFromDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker, rememberPredecessors } from "./PredecessorPicker";
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

/**
 * TaskDraft — the single superset payload emitted by the ONE shared task-create
 * modal. Both entry points (マイタスクの「タスクを依頼」 and ガントの「タスク作成」)
 * render THIS component and read the fields their flow supports:
 *   - ガント: title/status/priority/assignee/team/start/due/parent/先行
 *   - マイタスク: title/event/priority/assignee/team/due/内容/添付 (+ parent/先行 when
 *     an event scope is loaded)
 * Fields a given caller doesn't surface stay at their inert defaults.
 */
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
  /** Optional event link (マイタスク発行). null = unlinked / caller-fixed elsewhere. */
  eventId: common.EventId | null;
  /** Free-form 内容 (マイタスクのみ). null = 未記入. */
  description: string | null;
  attachments: DraftAttachments;
}

export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  users: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks in the (current) event, offered as WBS parents (親タスク). Empty
   *  hides the 親/先行 section (e.g. マイタスクでイベント未選択). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  /** every task in scope with its direct parent — predecessors are scoped to the
   *  chosen parent's siblings (判断10: 同一直接親のみ依存可). */
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

  // ---- shared-component configuration (per entry point) ----
  /** Modal heading (default「タスクを作成」). マイタスクは「タスクを依頼」を渡す。 */
  title?: string;
  /** Primary button label (default「作成する」). マイタスクは「依頼する」を渡す。 */
  submitLabel?: string;
  /** testId namespace so both callers keep their existing test ids
   *  (ガント=「fe4-create」/ マイタスク=「fe4-mytask-create」). */
  testIdPrefix?: string;
  /** ステータス欄を出すか (ガントのみ true)。 */
  showStatus?: boolean;
  /** 開始日欄を出すか (ガントのみ true)。 */
  showStart?: boolean;
  /** 対象イベント欄を出すか (マイタスクのみ true)。 */
  showEvent?: boolean;
  /** 内容(説明)欄を出すか (マイタスクのみ true)。 */
  showDescription?: boolean;
  /** 添付欄を出すか (マイタスクのみ true)。 */
  showAttachments?: boolean;
  /** 対象イベント候補 (showEvent 時)。 */
  events?: readonly EventOption[];
  /** 選択中の対象イベント変更を親へ通知 (マイタスクが scope を再ロードするため)。 */
  onEventChange?: (eventId: common.EventId | null) => void;
  /** 依頼主のヒント表示 (マイタスクのみ)。 */
  requesterName?: string;
}

// A newly-created task starts in "todo"; only todo-reachable states are offered.
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];
const NO_EVENT = ""; // sentinel for the "紐付けない" Select option

export function TaskCreateModal({
  open,
  onClose,
  users,
  teams,
  parentOptions,
  scopeTasks,
  onCreate,
  initialDue,
  initialParentId,
  initialDependsOn,
  title: modalTitle = "タスクを作成",
  submitLabel = "作成する",
  testIdPrefix = "fe4-create",
  showStatus = true,
  showStart = true,
  showEvent = false,
  showDescription = false,
  showAttachments = false,
  events = [],
  onEventChange,
  requesterName,
}: TaskCreateModalProps) {
  const p = testIdPrefix;
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [parentId, setParentId] = useState<common.TaskId | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [eventId, setEventId] = useState<common.EventId | "">(NO_EVENT);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<DraftFileAttachment[]>([]);
  const [urls, setUrls] = useState<DraftUrlAttachment[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlName, setUrlName] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Predecessors are scoped to the chosen TEAM (ADR-0007): same-team tasks across any
  // hierarchy level are offered; other teams are excluded (their work goes through the
  // request/approval flow). Recomputes whenever the team changes.
  const depOptions = useMemo(() => dependencyScopeOptions(scopeTasks, teamId), [scopeTasks, teamId]);

  // 親子は同一チーム: 親を選んだ子タスクは親のチームに固定する。
  const teamLockedToParent = parentId != null;
  // 親/先行の表示は候補があるときだけ（マイタスクでイベント未選択なら出さない）。
  const showRelations = parentOptions.length > 0 || scopeTasks.length > 0;

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
    setEventId(NO_EVENT);
    setDescription("");
    setFiles([]);
    setUrls([]);
    setUrlInput("");
    setUrlName("");
    setAttachError(null);
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
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
        eventId: showEvent ? (eventId === NO_EVENT ? null : (eventId as common.EventId)) : null,
        description: description.trim() ? description.trim() : null,
        attachments: { files, urls },
      });
      // Close ONLY on success — a failed create keeps the form (with its input) open.
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
      title={modalTitle}
      testId={`${p}-modal`}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" onClick={close} testId={`${p}-cancel`}>
            キャンセル
          </Button>
          <Button onClick={submit} loading={saving} disabled={!title.trim()} testId={`${p}-submit`}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      {requesterName && (
        <p className={styles.createHint} data-testid={`${p}-from`}>
          依頼主: <strong>{requesterName}</strong>
        </p>
      )}
      <div className={styles.formGrid}>
        <div className={styles.formFieldFull}>
          <label className={styles.formLabel} htmlFor={`${p}-title-input`}>
            タイトル<span className={styles.req}>*</span>
          </label>
          <TextField
            id={`${p}-title-input`}
            value={title}
            onChange={setTitle}
            placeholder="例: 会場の最終確認"
            testId={`${p}-title`}
          />
        </div>

        {showEvent && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`${p}-event-input`}>
              対象イベント（任意）
            </label>
            <Select
              id={`${p}-event-input`}
              value={eventId}
              onChange={(v) => {
                const next = ((v as common.EventId | "") || NO_EVENT) as common.EventId | "";
                setEventId(next);
                // イベントが変わったら親/先行は別スコープになるので選択を落とす。
                setParentId(null);
                setDeps([]);
                onEventChange?.(next === NO_EVENT ? null : (next as common.EventId));
              }}
              options={[
                { value: NO_EVENT, label: "紐付けない" },
                ...events.map((e) => ({ value: e.id, label: e.name })),
              ]}
              testId={`${p}-event`}
            />
          </div>
        )}

        {showStatus && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`${p}-status-input`}>
              ステータス
            </label>
            <Select
              id={`${p}-status-input`}
              value={status}
              onChange={(v) => setStatus(v as task.TaskStatus)}
              options={CREATE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              testId={`${p}-status`}
            />
          </div>
        )}

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${p}-priority-input`}>
            優先度
          </label>
          <Select
            id={`${p}-priority-input`}
            value={priority}
            onChange={(v) => setPriority(v as task.TaskPriority)}
            options={PRIORITIES.map((pr) => ({ value: pr, label: PRIORITY_LABEL[pr] }))}
            testId={`${p}-priority`}
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${p}-assignee-input`}>
            {showEvent ? "依頼先（担当者）" : "担当"}
          </label>
          <Select
            id={`${p}-assignee-input`}
            value={assigneeId ?? ""}
            onChange={(v) => setAssigneeId(v ? (v as common.UserId) : null)}
            options={[{ value: "", label: "未割当" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
            testId={`${p}-assignee`}
          />
        </div>

        {showStart ? (
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor={`${p}-start-input`}>
                開始日
              </label>
              <DateField id={`${p}-start-input`} value={start} onChange={setStart} testId={`${p}-start`} />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor={`${p}-due-input`}>
                期日
              </label>
              <DateField id={`${p}-due-input`} value={due} onChange={setDue} testId={`${p}-due`} />
            </div>
          </div>
        ) : (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`${p}-due-input`}>
              期限
            </label>
            <DateField id={`${p}-due-input`} value={due} onChange={setDue} testId={`${p}-due`} />
          </div>
        )}

        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`${p}-team-input`}>
              チーム
            </label>
            <Select
              id={`${p}-team-input`}
              value={teamId ?? ""}
              disabled={teamLockedToParent}
              onChange={(v) => {
                const next = v ? (v as common.TeamId) : null;
                setTeamId(next);
                // Changing the team drops now cross-team predecessors (ADR-0007).
                setDeps((d) => pruneToScope(scopeTasks, next, d));
              }}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId={`${p}-team`}
            />
            {teamLockedToParent && (
              <p className={styles.fieldHint} data-testid={`${p}-team-locked`}>
                親タスクと同じチームになります（変更できません）
              </p>
            )}
          </div>
        )}

        {showRelations && (
          <>
            {/* 親タスク → then 先行タスク: choose the WBS parent first, then dependencies.
                Predecessors are scoped to the chosen team (ADR-0007: 同一チーム整合). */}
            <div className={styles.formFieldFull}>
              <label className={styles.formLabel} htmlFor={`${p}-parent-input`}>
                親タスク（任意・未選択でトップレベル）
              </label>
              <Select
                id={`${p}-parent-input`}
                value={parentId ?? ""}
                onChange={(v) => {
                  const next = v ? (v as common.TaskId) : null;
                  setParentId(next);
                  // A parent fixes the team; re-scope predecessors to the parent's team.
                  const parentTeam = next ? teamOf(scopeTasks, next) : teamId;
                  if (next) setTeamId(parentTeam);
                  setDeps((d) => pruneToScope(scopeTasks, parentTeam, d));
                }}
                options={[{ value: "", label: "なし（トップレベル）" }, ...parentOptions.map((o) => ({ value: o.id, label: o.title }))]}
                testId={`${p}-parent`}
              />
            </div>

            <div className={styles.formFieldFull}>
              <span className={styles.formLabel}>先行タスク（依存・同じチーム内のタスク）</span>
              <PredecessorPicker options={depOptions} value={deps} onChange={setDeps} testId={`${p}-deps`} />
            </div>
          </>
        )}

        {showDescription && (
          <div className={styles.formFieldFull}>
            <label className={styles.formLabel} htmlFor={`${p}-desc-input`}>
              内容（任意）
            </label>
            <Textarea
              id={`${p}-desc-input`}
              value={description}
              onChange={setDescription}
              rows={3}
              placeholder="依頼の詳細や補足を書けます"
              testId={`${p}-desc`}
            />
          </div>
        )}

        {showAttachments && (
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
                data-testid={`${p}-file`}
                aria-label="ファイルを添付"
              />
            </div>
            <div className={styles.attachUrlRow}>
              <TextField
                id={`${p}-url-name-input`}
                value={urlName}
                onChange={setUrlName}
                placeholder="表示名（任意）"
                testId={`${p}-url-name`}
              />
              <TextField
                id={`${p}-url-input`}
                value={urlInput}
                onChange={setUrlInput}
                placeholder="https://example.com/..."
                testId={`${p}-url`}
              />
              <Button variant="ghost" onClick={addUrl} disabled={!urlInput.trim()} testId={`${p}-url-add`}>
                URLを追加
              </Button>
            </div>
            {attachError && (
              <p className={styles.attachError} data-testid={`${p}-attach-error`}>
                {attachError}
              </p>
            )}
            {(files.length > 0 || urls.length > 0) && (
              <ul className={styles.attachDraftList} data-testid={`${p}-attach-list`}>
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
        )}
      </div>
    </Modal>
  );
}
