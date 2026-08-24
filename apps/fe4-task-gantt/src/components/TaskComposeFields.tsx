import { useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { TextField, Textarea, Select, Button } from "@dub/ui";
import { TaskSearchSelect } from "@dub/app-ui";
import { PRIORITY_LABEL, STATUS_LABEL } from "../domain/task-form";
import { DateField } from "./DateField";
import { PredecessorPicker } from "./PredecessorPicker";
import styles from "../styles/app.module.css";

/* ─────────────────────────────────────────────────────────────────────────────
 * ③ 作成モーダルの完全共通化 (判断99):
 * ガント「タスクを作成」とマイタスク「タスクを発行」の *フォーム本体* を、この単一
 * コンポーネントに集約する。両モーダルは同一のフィールド集合・同一レイアウト・同一
 * ラベルで完全に一致する（差分は下記の context だけ）。
 *
 * context ごとの差（フィールドの有無ではなく「状態」の差・報告済み）:
 *   - 対象イベント: gantt = 現在のイベントに固定表示（disabled）／issue = 選択可（紐付けない可）。
 *     ガントはビュー自体が単一イベントに束縛されるため、別イベントへは発行できない。
 *   - 親/先行タスク: gantt = 常時（イベント固定でスコープが常にある）／issue = 対象イベントを
 *     選んで初めて表示（イベント無しのタスクにはイベント内の親子・依存を張れない）。
 * ───────────────────────────────────────────────────────────────────────────── */

/** A file the user attached in the modal — read into a self-contained data: URL
 *  (minimal impl; a file-meta/R2 blob upload is a documented follow-up). */
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

/** Shared attachment-draft state + handlers so both modals get identical 添付 UX. */
export function useAttachmentDraft() {
  const [files, setFiles] = useState<DraftFileAttachment[]>([]);
  const [urls, setUrls] = useState<DraftUrlAttachment[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlName, setUrlName] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);

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

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, j) => j !== i));
  const removeUrl = (i: number) => setUrls((prev) => prev.filter((_, j) => j !== i));

  const reset = () => {
    setFiles([]);
    setUrls([]);
    setUrlInput("");
    setUrlName("");
    setAttachError(null);
  };

  return {
    files, urls, urlInput, urlName, attachError,
    setUrlInput, setUrlName,
    onPickFiles, addUrl, removeFile, removeUrl, reset,
  };
}

const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

const NO_EVENT = ""; // sentinel for the "紐付けない" Select option

export interface TaskComposeFieldsProps {
  /** htmlFor id prefix (gantt="fe4-create", issue="fe4-mytask"). */
  idPrefix: string;
  /** data-testid prefix (gantt="fe4-create", issue="fe4-mytask-create"). */
  testIdPrefix: string;

  // ── title ──
  title: string;
  onTitle: (v: string) => void;
  titlePlaceholder: string;

  // ── 対象イベント ──
  /** locked = gantt（現在のイベントに固定）／select = issue（選択可）。 */
  eventMode: "locked" | "select";
  eventValue: common.EventId | "";
  eventOptions: readonly { id: common.EventId; name: string }[];
  onEvent?: (v: common.EventId | "") => void;

  // ── ステータス ──
  status: task.TaskStatus;
  onStatus: (v: task.TaskStatus) => void;

  // ── 優先度 ──
  priority: task.TaskPriority;
  onPriority: (v: task.TaskPriority) => void;

  // ── 担当者 ──
  people: readonly identity.UserSummary[];
  assigneeId: common.UserId | null;
  onAssignee: (v: common.UserId | null) => void;

  // ── 開始日 / 期日 ──
  start: string | null;
  onStart: (v: string | null) => void;
  due: string | null;
  onDue: (v: string | null) => void;

  // ── チーム ──
  teams: readonly team.Team[];
  teamId: common.TeamId | null;
  onTeam: (v: common.TeamId | null) => void;
  teamLocked: boolean;

  // ── 親 / 先行 ──
  showRelations: boolean;
  parentId: common.TaskId | null;
  onParent: (v: common.TaskId | null) => void;
  parentOptions: readonly { id: common.TaskId; title: string }[];
  deps: common.TaskId[];
  onDeps: (v: common.TaskId[]) => void;
  depOptions: readonly { id: common.TaskId; title: string }[];

  // ── 内容 ──
  description: string;
  onDescription: (v: string) => void;

  // ── 添付 ──
  files: readonly DraftFileAttachment[];
  urls: readonly DraftUrlAttachment[];
  urlInput: string;
  urlName: string;
  attachError: string | null;
  onUrlInput: (v: string) => void;
  onUrlName: (v: string) => void;
  onPickFiles: (l: FileList | null) => void;
  onAddUrl: () => void;
  onRemoveFile: (i: number) => void;
  onRemoveUrl: (i: number) => void;
}

/**
 * The single, shared body for both task-compose modals. Renders the identical
 * field set / order / labels in every context; only the two documented context
 * behaviours (対象イベント lock, 親/先行 visibility) vary via props.
 */
export function TaskComposeFields(p: TaskComposeFieldsProps) {
  const tid = p.testIdPrefix;
  const idp = p.idPrefix;

  return (
    <div className={styles.formGrid}>
      {/* タイトル */}
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel} htmlFor={`${idp}-title`}>
          タイトル<span className={styles.req}>*</span>
        </label>
        <TextField
          id={`${idp}-title`}
          value={p.title}
          onChange={p.onTitle}
          placeholder={p.titlePlaceholder}
          testId={`${tid}-title`}
        />
      </div>

      {/* 対象イベント */}
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor={`${idp}-event`}>
          対象イベント（任意）
        </label>
        <Select
          id={`${idp}-event`}
          value={p.eventValue}
          disabled={p.eventMode === "locked"}
          onChange={(v) => p.onEvent?.(v as common.EventId | "")}
          options={[
            { value: NO_EVENT, label: "紐付けない" },
            ...p.eventOptions.map((e) => ({ value: e.id, label: e.name })),
          ]}
          testId={`${tid}-event`}
        />
        {p.eventMode === "locked" && (
          <p className={styles.fieldHint} data-testid={`${tid}-event-locked`}>
            このガントのイベントに追加されます（変更できません）
          </p>
        )}
      </div>

      {/* ステータス */}
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor={`${idp}-status`}>
          ステータス
        </label>
        <Select
          id={`${idp}-status`}
          value={p.status}
          onChange={(v) => p.onStatus(v as task.TaskStatus)}
          options={CREATE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
          testId={`${tid}-status`}
        />
      </div>

      {/* 優先度 */}
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor={`${idp}-priority`}>
          優先度
        </label>
        <Select
          id={`${idp}-priority`}
          value={p.priority}
          onChange={(v) => p.onPriority(v as task.TaskPriority)}
          options={PRIORITIES.map((pr) => ({ value: pr, label: PRIORITY_LABEL[pr] }))}
          testId={`${tid}-priority`}
        />
      </div>

      {/* 担当者 */}
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor={`${idp}-assignee`}>
          担当者
        </label>
        <Select
          id={`${idp}-assignee`}
          value={p.assigneeId ?? ""}
          onChange={(v) => p.onAssignee(v ? (v as common.UserId) : null)}
          options={[{ value: "", label: "未割当" }, ...p.people.map((u) => ({ value: u.id, label: u.displayName }))]}
          testId={`${tid}-assignee`}
        />
      </div>

      {/* 開始日 / 期日 */}
      <div className={styles.formRow}>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idp}-start`}>
            開始日
          </label>
          <DateField id={`${idp}-start`} value={p.start} onChange={p.onStart} testId={`${tid}-start`} />
        </div>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idp}-due`}>
            期日
          </label>
          <DateField id={`${idp}-due`} value={p.due} onChange={p.onDue} testId={`${tid}-due`} />
        </div>
      </div>

      {/* チーム */}
      {p.teams.length > 0 && (
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idp}-team`}>
            チーム
          </label>
          <Select
            id={`${idp}-team`}
            value={p.teamId ?? ""}
            disabled={p.teamLocked}
            onChange={(v) => p.onTeam(v ? (v as common.TeamId) : null)}
            options={[{ value: "", label: "未割当" }, ...p.teams.map((t) => ({ value: t.id, label: t.name }))]}
            testId={`${tid}-team`}
          />
          {p.teamLocked && (
            <p className={styles.fieldHint} data-testid={`${tid}-team-locked`}>
              親タスクと同じチームになります（変更できません）
            </p>
          )}
        </div>
      )}

      {/* 親タスク */}
      {p.showRelations && (
        <div className={styles.formFieldFull}>
          <span className={styles.formLabel}>親タスク（任意・未選択でトップレベル）</span>
          <TaskSearchSelect<common.TaskId>
            value={p.parentId}
            options={p.parentOptions}
            placeholder="タスク名で検索・一覧から選択…"
            emptyOptionsLabel="親にできるタスクがありません"
            hint="空欄のままなら親なし（トップレベル）。親を選ぶとチームは親に合わせます。"
            onChange={p.onParent}
            testId={`${tid}-parent`}
          />
        </div>
      )}

      {/* 先行タスク */}
      {p.showRelations && (
        <div className={styles.formFieldFull}>
          <span className={styles.formLabel}>先行タスク（依存・同じ親のタスクのみ）</span>
          <PredecessorPicker options={p.depOptions} value={p.deps} onChange={p.onDeps} testId={`${tid}-deps`} />
        </div>
      )}

      {/* 内容 */}
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel} htmlFor={`${idp}-desc`}>
          内容（任意）
        </label>
        <Textarea
          id={`${idp}-desc`}
          value={p.description}
          onChange={p.onDescription}
          rows={3}
          placeholder="詳細や補足を書けます"
          testId={`${tid}-desc`}
        />
      </div>

      {/* 添付 */}
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel}>添付（ファイル・URL）</label>
        <div className={styles.attachRow}>
          <input
            type="file"
            multiple
            className={styles.attachFileInput}
            onChange={(e) => {
              void p.onPickFiles(e.target.files);
              e.target.value = "";
            }}
            data-testid={`${tid}-file`}
            aria-label="ファイルを添付"
          />
        </div>
        <div className={styles.attachUrlRow}>
          <TextField
            id={`${idp}-url-name`}
            value={p.urlName}
            onChange={p.onUrlName}
            placeholder="表示名（任意）"
            testId={`${tid}-url-name`}
          />
          <TextField
            id={`${idp}-url`}
            value={p.urlInput}
            onChange={p.onUrlInput}
            placeholder="https://example.com/..."
            testId={`${tid}-url`}
          />
          <Button variant="ghost" onClick={p.onAddUrl} disabled={!p.urlInput.trim()} testId={`${tid}-url-add`}>
            URLを追加
          </Button>
        </div>
        {p.attachError && (
          <p className={styles.attachError} data-testid={`${tid}-attach-error`}>
            {p.attachError}
          </p>
        )}
        {(p.files.length > 0 || p.urls.length > 0) && (
          <ul className={styles.attachDraftList} data-testid={`${tid}-attach-list`}>
            {p.files.map((f, i) => (
              <li key={`f-${i}`} className={styles.attachDraftItem}>
                <span className={styles.attachDraftName}>📎 {f.name}</span>
                <button
                  type="button"
                  className={styles.attachDraftRemove}
                  onClick={() => p.onRemoveFile(i)}
                  aria-label={`${f.name} を外す`}
                >
                  ×
                </button>
              </li>
            ))}
            {p.urls.map((u, i) => (
              <li key={`u-${i}`} className={styles.attachDraftItem}>
                <span className={styles.attachDraftName}>🔗 {u.name}</span>
                <button
                  type="button"
                  className={styles.attachDraftRemove}
                  onClick={() => p.onRemoveUrl(i)}
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
  );
}
