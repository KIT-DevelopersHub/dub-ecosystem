import { useEffect, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Textarea, Select } from "@dub/ui";
import { TaskSearchSelect } from "@dub/app-ui";
import { PRIORITY_LABEL, isoFromDateInput, todayDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker } from "./PredecessorPicker";
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
  /** WBS 親タスク（親子関係）. null ⇒ トップレベル（親なし）. 子は親と同じチームに固定される
   *  （親子でチームが食い違う状態は作れない・ADR-0006/0007 と整合）。 */
  parentId: common.TaskId | null;
  /** 先行タスク（依存＝この新規タスクが待つタスク）. 同一チーム内のタスクのみ（クロスチーム依存不可）。 */
  dependsOnIds: common.TaskId[];
  /** 開始日 (planned start). Maps to Task.startAt. null ⇒ 開始日なし. */
  startAt: common.ISODateTime | null;
  /** 終了日 (旧「期限」相当). Maps to Task.dueAt — the deadline / gantt bar end. When
   *  both startAt and dueAt are set the ガントのバー spans exactly [startAt, dueAt]. */
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
  /** 親から「子タスクを作成」で開いたとき true — 子のチームは親のチームに固定する。親子で
   *  チームが食い違う状態を作れないよう、チーム欄を親の値でプリフィルし変更不可（disabled）に
   *  する。`parentTeamId` が固定先（親のチーム。親が未割当なら null=未割当で固定）。既存の
   *  クロスチーム依存制約（依存は同一チームのみ・ADR-0006/0007）と整合。 */
  lockTeamToParent?: boolean;
  /** 親タスクのチーム — `lockTeamToParent` が true のときの固定先。 */
  parentTeamId?: common.TeamId | null;
  /** ③ 先行タスク・親タスクを選ぶための候補（現在の対象イベントのタスク一覧・チーム情報つき）。
   *  非空のとき、モーダルに「親タスク」検索と「先行タスク」ピッカーを表示する。空/未指定なら両欄を
   *  出さない（イベント未確定のマイタスク発行など、スコープが無い場面では出さない）。親子・依存は
   *  同一チーム制約に従い、親を選ぶとチームは親のチームに固定される。 */
  scopeTasks?: readonly ScopeTask[];
  /** `scopeTasks` が属する対象イベント。モーダルで選択中の対象イベントがこれと一致するときだけ
   *  親/先行の候補を出す（別イベントの親子・依存を作らせない）。ガントのように常にイベント固定
   *  （`lockEventToDefault`）なら無視される。 */
  scopeEventId?: common.EventId | null;
  /** 親タスクの初期選択（ガント「＋子タスクを作成」からのプリセット）。 */
  initialParentId?: common.TaskId | null;
  /** 先行タスクの初期選択（ガントのセル/先行プリセット）。 */
  initialDependsOn?: readonly common.TaskId[];
  /** 対象イベントが変わったら親（呼び出し側）へ通知する。マイタスクは候補（scopeTasks）を
   *  そのイベントで再ロードするために使う。 */
  onEventChange?: (eventId: common.EventId | null) => void;
  /** ③ ガントからの発行では 対象イベント を選ばせない — ヘッダーで選択中のイベント
   *  (defaultEventId) で確定し、他イベント混在を防ぐ。true のとき「対象イベント」欄を
   *  出さず、作成時は defaultEventId を裏で自動セットする（ユーザーには見せない）。
   *  false（既定）＝マイタスクの発行のように 対象イベント を選べる（紐付けない も可）。 */
  lockEventToDefault?: boolean;
  /** 終了日の初期値 (YYYY-MM-DD) — seeded each time the modal opens. Used by the ガント
   *  "＋子タスクを作成 / ＋先行タスクを作成 / タイムラインのセルから作成" entry points, which
   *  compute an end so the new bar lands relative to its parent/successor. When it is
   *  earlier than today the 開始日 clamps down to it so the range is never inverted.
   *  Null ⇒ the plain 発行/新規 flow: 開始日・終了日ともに今日が初期値。 */
  initialDue?: string | null;
  /** Modal heading (default「タスクを発行」). The send/receive flow passes「タスクを依頼」. */
  title?: string;
  /** Primary button label (default「発行する」). Send/receive passes「依頼する」. */
  submitLabel?: string;
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

export function MyTaskCreateModal({ open, onClose, events, people, teams, onCreate, requesterName, defaultEventId, defaultTeamId, lockTeamToParent = false, parentTeamId = null, scopeTasks, scopeEventId = null, initialParentId = null, initialDependsOn, onEventChange, lockEventToDefault = false, initialDue, title: modalTitle = "タスクを発行", submitLabel = "発行する" }: MyTaskCreateModalProps) {
  // The header-selected event is the initial 対象イベント, but only when it is a real
  // option in `events` (guards against a stale/foreign id) — otherwise start unlinked.
  const seedEventId = (): common.EventId | "" =>
    defaultEventId && events.some((e) => e.id === defaultEventId) ? defaultEventId : NO_EVENT;
  // The requester's own team is the initial チーム, but only when it is a real option in
  // `teams` (guards against a stale/foreign id) — otherwise start 未割当. When creating a
  // 子タスク (lockTeamToParent) the seed is the PARENT's team instead, and the field is
  // locked below so 親子でチームが食い違う状態を作れない (親が未割当なら null=未割当で固定)。
  const seedParentId = (): common.TaskId | null => initialParentId ?? null;
  const seedTeamId = (): common.TeamId | null => {
    // ロック（ガントの子作成プリセット）は明示された親チームで固定。
    if (lockTeamToParent) return parentTeamId ?? null;
    // 親をプリセット選択している場合は、その親のチームに合わせる（親子で同一チーム）。
    const p = seedParentId();
    if (p) return teamOf(scopeTasks ?? [], p);
    return defaultTeamId && teams.some((t) => t.id === defaultTeamId) ? defaultTeamId : null;
  };
  const seedDeps = (): common.TaskId[] => (initialDependsOn ? [...initialDependsOn] : []);
  // 開始日/終了日 の初期値。プレーンな 発行/新規 では両方とも「今日」。ガントのプリセット
  // (親/先行/セル由来の initialDue) では 終了日=そのプリセット・開始日=min(今日, プリセット)
  // として範囲が逆転しないようにする。
  const seedEnd = (): string => initialDue ?? todayDateInput();
  const seedStart = (): string => {
    const today = todayDateInput();
    return initialDue && initialDue < today ? initialDue : today;
  };

  const [eventId, setEventId] = useState<common.EventId | "">(seedEventId);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [priority, setPriority] = useState<task.TaskPriority | "">(NO_PRIORITY);
  const [teamId, setTeamId] = useState<common.TeamId | null>(seedTeamId);
  const [parentId, setParentId] = useState<common.TaskId | null>(seedParentId);
  const [deps, setDeps] = useState<common.TaskId[]>(seedDeps);
  const [startDate, setStartDate] = useState<string | null>(seedStart);
  const [endDate, setEndDate] = useState<string | null>(seedEnd);
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
      setParentId(seedParentId());
      setTeamId(seedTeamId());
      setDeps(seedDeps());
      setStartDate(seedStart());
      setEndDate(seedEnd());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultEventId, defaultTeamId, teams, initialDue, lockTeamToParent, parentTeamId, initialParentId, initialDependsOn, scopeTasks]);

  const reset = () => {
    setEventId(seedEventId());
    setTitle("");
    setAssigneeId(null);
    setPriority(NO_PRIORITY);
    setTeamId(seedTeamId());
    setParentId(seedParentId());
    setDeps(seedDeps());
    setStartDate(seedStart());
    setEndDate(seedEnd());
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

  // ③ 親タスク・先行タスク（親子/依存）を選ぶための候補とロック状態を導出する。
  // scope = 対象イベントのタスク（チーム情報つき）。空/未指定なら関係欄は出さない。
  const scope = scopeTasks ?? [];
  // 別イベントの親子・依存を作らせない: ガント（lockEventToDefault）は常に固定イベントなので表示。
  // マイタスクは「選択中の対象イベント」が候補の属するイベント(scopeEventId)と一致するときだけ表示。
  const selectedEventId: common.EventId | null =
    lockEventToDefault ? (defaultEventId ?? null) : eventId === NO_EVENT ? null : (eventId as common.EventId);
  const scopeMatchesEvent = lockEventToDefault || (selectedEventId != null && selectedEventId === scopeEventId);
  const showRelationFields = scope.length > 0 && scopeMatchesEvent;

  // チームのロック: ガントの子作成プリセット(lockTeamToParent) か、モーダルで親を選んだとき。
  // どちらの場合も子は親と同じチームに固定する（親子でチーム不一致を作らせない）。
  const lockedParentTeam: common.TeamId | null = lockTeamToParent
    ? (parentTeamId ?? null)
    : parentId
      ? teamOf(scope, parentId)
      : null;
  const teamLocked = lockTeamToParent || parentId != null;
  // 依存（先行）のスコープ境界＝チーム。ロック時は親のチーム、非ロック時は選択中チーム。
  const effectiveTeam: common.TeamId | null = teamLocked ? lockedParentTeam : teamId;

  const parentOptions = scope.map((s) => ({ id: s.id, title: s.title }));
  const predecessorOptions = dependencyScopeOptions(scope, effectiveTeam, parentId ?? null);

  // 親タスクを選ぶ/外すと、子のチームを親のチームへ合わせ、別チームになった先行（依存）を落とす。
  const onChangeParent = (next: common.TaskId | null) => {
    setParentId(next);
    if (next) {
      const nextTeam = teamOf(scope, next);
      setTeamId(nextTeam);
      setDeps((d) => pruneToScope(scope, nextTeam, d).filter((id) => id !== next));
    }
  };
  // 対象イベントを変えたら親（呼び出し側）へ通知（候補の再ロード用）＋現在の親/先行を解除。
  const onChangeEvent = (next: common.EventId | "") => {
    setEventId(next);
    setParentId(null);
    setDeps([]);
    onEventChange?.(next === NO_EVENT ? null : (next as common.EventId));
  };

  // 開始日 must not be after 終了日 (both default to 今日, so this only blocks a manual
  // inversion). An empty side is always fine (開始日なし / 終了日なし).
  const datesValid = !(startDate && endDate && startDate > endDate);
  // Event link is optional now — the title and a valid date range gate submission.
  const canSubmit = title.trim().length > 0 && datesValid && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onCreate({
        // ③ 発行を「ヘッダー選択中イベント」で確定する（欄を隠しても DB 上の eventId は必須）。
        // lock 時は表示せず defaultEventId を裏で自動セット。非 lock 時は選択値（未選択=紐付けない）。
        eventId: lockEventToDefault ? (defaultEventId ?? null) : eventId === NO_EVENT ? null : (eventId as common.EventId),
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        priority: priority === NO_PRIORITY ? null : (priority as task.TaskPriority),
        assigneeId,
        // 子タスク作成時はチームを親に固定（UIは disabled だが念のため送信値も親で確定）。
        teamId: teamLocked ? lockedParentTeam : teamId,
        // ③ 親子（親タスク）・依存（先行タスク）。関係欄を出していない場面では null / 空で送る。
        parentId: showRelationFields || lockTeamToParent ? parentId : null,
        dependsOnIds: showRelationFields ? deps : [],
        startAt: isoFromDateInput(startDate),
        dueAt: isoFromDateInput(endDate),
        attachments: { files, urls },
      });
      reset();
      onClose();
    } catch {
      // Create failed — keep the modal open (with its input) so the requester can retry.
      // The reason is surfaced by the caller (toast / ErrorDialog); nothing to do here.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={modalTitle}
      testId="fe4-mytask-create-modal"
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" onClick={close} testId="fe4-mytask-create-cancel">
            キャンセル
          </Button>
          <Button onClick={submit} loading={saving} disabled={!canSubmit} testId="fe4-mytask-create-submit">
            {submitLabel}
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

        {/* ③ 対象イベント欄は lock 時に出さない（ヘッダー選択中イベントで確定・裏で自動セット）。 */}
        {!lockEventToDefault && (
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
        )}

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

        {/* ③ 開始日・終了日 は同じ行に横並び（左=開始 / 右=終了）。縦積みをやめて一目で範囲が読める。 */}
        <div className={styles.formFieldFull}>
          <div className={styles.formDateRow}>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="fe4-mytask-start">
                開始日
              </label>
              <DateField id="fe4-mytask-start" value={startDate} onChange={setStartDate} testId="fe4-mytask-create-start" />
            </div>

            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="fe4-mytask-due">
                終了日
              </label>
              <DateField id="fe4-mytask-due" value={endDate} onChange={setEndDate} testId="fe4-mytask-create-due" />
            </div>
          </div>
          {!datesValid && (
            <p className={styles.fieldError} data-testid="fe4-mytask-create-date-error">
              終了日は開始日以降にしてください
            </p>
          )}
        </div>

        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-mytask-team">
              チーム
            </label>
            <Select
              id="fe4-mytask-team"
              value={teamId ?? ""}
              disabled={teamLocked}
              onChange={(v) => setTeamId(v ? (v as common.TeamId) : null)}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId="fe4-mytask-create-team"
            />
            {teamLocked && (
              <p className={styles.fieldHint} data-testid="fe4-mytask-create-team-locked">
                親タスクと同じチームになります（変更できません）
              </p>
            )}
          </div>
        )}

        {/* ③ 親タスク（親子関係）: 現在のイベントのタスクから検索して親を選べる。親を選ぶと
            チームは親のチームに固定される（親子で同一チーム）。空欄＝親なし（トップレベル）。
            ガント・マイタスク共通（同一 MyTaskCreateModal）。scope が無い場面では出さない。 */}
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

        {/* ③ 先行タスク（依存）: この新規タスクが待つ先行タスクを、同じチーム内のタスクから選べる。
            クロスチーム依存は不可（options が同一チームに絞られる）。ガント・マイタスク共通。 */}
        {showRelationFields && (
          <div className={styles.formFieldFull}>
            <span className={styles.formLabel}>先行タスク（依存・同じチーム内のタスク・任意）</span>
            <PredecessorPicker
              options={predecessorOptions}
              value={deps}
              onChange={setDeps}
              testId="fe4-mytask-create-deps"
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
