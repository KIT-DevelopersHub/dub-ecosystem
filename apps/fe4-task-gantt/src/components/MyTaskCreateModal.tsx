import { useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Textarea, Select } from "@dub/ui";
import { TaskSearchSelect } from "@dub/app-ui";
import { PRIORITY_LABEL, isoFromDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker } from "./PredecessorPicker";
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
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  /** WBS 親タスク（親子関係）. null ⇒ トップレベル（親なし）. 子は親と同じチームに固定される
   *  （親子でチームが食い違う状態は作れない・サーバも 422 で担保）。 */
  parentId: common.TaskId | null;
  /** 先行タスク（依存＝この新規タスクが待つタスク）. 同じ親スコープ内のタスクのみ。 */
  dependsOnIds: common.TaskId[];
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
  /** ③ 先行タスク・親タスクを選ぶための候補（`scopeEventId` イベントのタスク一覧・チーム情報つき）。
   *  非空 かつ モーダルで選択中の対象イベントが `scopeEventId` と一致するときだけ、親タスク検索と
   *  先行タスクピッカーを出す（別イベントの親子・依存を作らせない）。空/未指定なら両欄を出さない。 */
  scopeTasks?: readonly ScopeTask[];
  /** `scopeTasks` が属する対象イベント。モーダルで選択中の対象イベントがこれと一致するときだけ関係欄を出す。 */
  scopeEventId?: common.EventId | null;
  /** 対象イベントが変わったら親（呼び出し側）へ通知する。呼び出し側は候補（scopeTasks）を
   *  そのイベントで読み直す（親子・依存は同一イベント内でのみ）。 */
  onEventChange?: (eventId: common.EventId | null) => void;
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

export function MyTaskCreateModal({ open, onClose, events, people, teams, onCreate, requesterName, scopeTasks, scopeEventId = null, onEventChange }: MyTaskCreateModalProps) {
  const [eventId, setEventId] = useState<common.EventId | "">(NO_EVENT);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [parentId, setParentId] = useState<common.TaskId | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [due, setDue] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<DraftFileAttachment[]>([]);
  const [urls, setUrls] = useState<DraftUrlAttachment[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlName, setUrlName] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEventId(NO_EVENT);
    setTitle("");
    setAssigneeId(null);
    setPriority("medium");
    setTeamId(null);
    setParentId(null);
    setDeps([]);
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

  // ③ 親タスク・先行タスク（親子/依存）を選ぶための候補とロック状態を導出する。
  // scope = 対象イベントのタスク（チーム情報つき）。空/未指定なら関係欄は出さない。
  const scope = scopeTasks ?? [];
  const selectedEventId: common.EventId | null = eventId === NO_EVENT ? null : (eventId as common.EventId);
  // 別イベントの親子・依存を作らせない: 選択中の対象イベントが候補の属するイベント(scopeEventId)と
  // 一致するときだけ関係欄を出す。
  const scopeMatchesEvent = selectedEventId != null && selectedEventId === scopeEventId;
  const showRelationFields = scope.length > 0 && scopeMatchesEvent;
  // 親子は同一チーム: 親を選んだらチームは親のチームに固定する（親子でチーム不一致を作らせない）。
  const teamLockedToParent = parentId != null;
  // 先行（依存）は選んだ親スコープ内のみ（#356 TaskCreateModal と同一の same-parent スコープ）。
  const depOptions = dependencyScopeOptions(scope, parentId);
  const parentOptions = scope.map((s) => ({ id: s.id, title: s.title }));

  // 親タスクを選ぶ/外すと、別スコープになった先行（依存）を落とし、子のチームを親のチームへ合わせる。
  const onChangeParent = (next: common.TaskId | null) => {
    setParentId(next);
    setDeps((d) => pruneToScope(scope, next, d).filter((id) => id !== next));
    if (next) setTeamId(teamOf(scope, next));
  };
  // 対象イベントを変えたら親（呼び出し側）へ通知（候補の再ロード用）＋現在の親/先行を解除。
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
        priority,
        assigneeId,
        // 親を選んでいれば子は親のチームに固定（UIは disabled だが送信値も親で確定）。
        teamId: teamLockedToParent ? teamOf(scope, parentId) : teamId,
        // ③ 親子（親タスク）・依存（先行タスク）。関係欄を出していない場面では null / 空で送る。
        parentId: showRelationFields ? parentId : null,
        dependsOnIds: showRelationFields ? deps : [],
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
            onChange={(v) => onChangeEvent(v as common.EventId | "")}
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
              disabled={teamLockedToParent}
              onChange={(v) => setTeamId(v ? (v as common.TeamId) : null)}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId="fe4-mytask-create-team"
            />
            {teamLockedToParent && (
              <p className={styles.fieldHint} data-testid="fe4-mytask-create-team-locked">
                親タスクと同じチームになります（変更できません）
              </p>
            )}
          </div>
        )}

        {/* ③ 親タスク（親子関係）: 選択中イベントのタスクから検索して親を選べる。親を選ぶと
            チームは親のチームに固定される（親子で同一チーム）。空欄＝親なし（トップレベル）。
            ガント（TaskCreateModal）と同じ same-parent スコープ。scope が無い場面では出さない。 */}
        {showRelationFields && (
          <div className={styles.formFieldFull}>
            <span className={styles.formLabel}>親タスク（親子関係・任意）</span>
            <TaskSearchSelect<common.TaskId>
              value={parentId}
              options={parentOptions}
              placeholder="タスク名で検索・一覧から選択…"
              emptyOptionsLabel="親にできるタスクがありません"
              hint="空欄のままなら親なし（トップレベル）。親を選ぶとチームは親に合わせます。"
              onChange={onChangeParent}
              testId="fe4-mytask-create-parent"
            />
          </div>
        )}

        {/* ③ 先行タスク（依存）: この新規タスクが待つ先行タスクを、同じ親スコープのタスクから選べる。
            ガント（TaskCreateModal）と同じピッカー・同じスコープ規則。 */}
        {showRelationFields && (
          <div className={styles.formFieldFull}>
            <span className={styles.formLabel}>先行タスク（依存・同じ親のタスクのみ・任意）</span>
            <PredecessorPicker options={depOptions} value={deps} onChange={setDeps} testId="fe4-mytask-create-deps" />
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
