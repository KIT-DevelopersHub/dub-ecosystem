import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { common, identity, task } from "@dub/types";
import { Avatar, Button, Modal, Select, TextField, Textarea, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTaskRequests, acceptTaskRequest, declineTaskRequest, cancelTaskRequest, resolveUsers } from "../api/endpoints";
import { createUserCache, ensureUsers, displayName, type UserCache } from "../domain/user-cache";
import { PRIORITY_LABEL, STATUS_LABEL, dateInputFromIso, isoFromDateInput } from "../domain/task-form";
import { MAX_ATTACHMENT_BYTES, readFileAsDataUrl } from "../domain/attachments";
import { AttachmentField, type AttachmentChip } from "./AttachmentField";
import { DateField } from "./DateField";
import styles from "../styles/app.module.css";

export interface MyTaskRequestsProps {
  /** Seed roster so from/to names render without a round-trip when already known. */
  seedUsers: readonly identity.UserSummary[];
  /** Fired after an accept so the parent can refresh anything it derives from requests. */
  onChanged: () => void;
}

/** Direction of a request from the current user's point of view.
 *  `in`  = 他人 → 自分 で、いま自分が承諾/却下する番   → ボールは自分   → 右
 *  `out` = 自分 → 他人 で、相手の承諾待ち                → ボールは相手   → 左 (自分側に ←) */
type Dir = "in" | "out";
interface ChatItem {
  r: task.TaskRequest;
  dir: Dir;
}

const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];
const STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];

/**
 * The gantt タスク詳細 lets you edit タイトル/詳細/📎添付/開始・終了日/ステータス/優先度 in place.
 * The 送る・受け取る request has no backend PATCH (accept/decline/cancel only) and no
 * startAt/status columns — so the same edit experience is mirrored here as an optimistic,
 * session-local draft (the card + reopened dialog reflect it immediately; the backend is
 * untouched). Kept per-request so edits survive close/reopen within a session.
 */
interface RequestDraft {
  title: string;
  description: string; // "" ⇒ 内容なし
  priority: task.TaskPriority;
  status: task.TaskStatus; // demo-only: TaskRequest にステータス列は無い（承認後タスクの初期状態）
  start: string | null; // yyyy-mm-dd, demo-only（TaskRequest に startAt は無い）
  due: string | null; // yyyy-mm-dd（TaskRequest.dueAt に対応）
  attachments: AttachmentChip[];
}

function draftFromRequest(r: task.TaskRequest): RequestDraft {
  return {
    title: r.title,
    description: r.description ?? "",
    priority: r.priority,
    status: "todo",
    start: null,
    due: dateInputFromIso(r.dueAt),
    attachments: [],
  };
}

/** 依頼日を短く。今日なら HH:mm、それ以外は M/D HH:mm。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/**
 * 送る・受け取る — the マイタスク request timeline, laid out like a chat (LINE/TaskTalk 風)。
 * すべての依頼を1本の時系列に並べ、「いまボールを持っている人」で左右を決める:
 *   - 他人から自分に依頼され承諾/却下する番 → ボールは自分 → 右（自分がボール）
 *   - 自分が誰かに依頼して相手の承諾待ち   → ボールは相手 → 左（渡したので自分側に ←）
 * カード上はタイトルと相手アイコン（＋名前）だけに絞り、編集・本文・優先度・状態・承諾/却下/取消は
 * カードをクリックした詳細ダイヤログ（中央モーダル・ガントのタスク詳細と同等の編集体験）に逃がす。
 * 承諾/却下/取消でボールが移ったら行が消える（楽観的にドロップして再取得）。バックエンドは不変。
 */
export function MyTaskRequests({ seedUsers, onChanged }: MyTaskRequestsProps) {
  const client = useApiClient();
  const toast = useToast();
  const [incoming, setIncoming] = useState<task.TaskRequest[]>([]);
  const [outgoing, setOutgoing] = useState<task.TaskRequest[]>([]);
  const [users, setUsers] = useState<UserCache>(() => createUserCache(seedUsers));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [openItem, setOpenItem] = useState<ChatItem | null>(null);
  // Session-local edit drafts (see RequestDraft) keyed by request id — the backend has no
  // request PATCH, so 保存 commits here (optimistic) and the card/dialog read from it.
  const [drafts, setDrafts] = useState<ReadonlyMap<string, RequestDraft>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inc, out] = await Promise.all([
        listTaskRequests(client, { box: "incoming", state: ["pending"] }),
        listTaskRequests(client, { box: "outgoing", state: ["pending"] }),
      ]);
      setIncoming(inc.items);
      setOutgoing(out.items);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Resolve requester/receiver display names (batched, cache-backed).
  useEffect(() => {
    const ids = [...incoming.map((r) => r.fromUserId), ...outgoing.map((r) => r.toUserId)];
    void ensureUsers(users, ids, (batch) => resolveUsers(client, batch)).then((c) => setUsers(new Map(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, outgoing]);

  // Merge both boxes into one chat timeline, oldest → newest (chat order).
  const timeline = useMemo<ChatItem[]>(() => {
    const items: ChatItem[] = [
      ...incoming.map((r) => ({ r, dir: "in" as const })),
      ...outgoing.map((r) => ({ r, dir: "out" as const })),
    ];
    return items.sort((a, b) => a.r.createdAt.localeCompare(b.r.createdAt));
  }, [incoming, outgoing]);

  const setRowBusy = (id: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  // Optimistically drop the row from `list`; restore it on failure. `after` runs on success.
  const act = async (
    r: task.TaskRequest,
    which: Dir,
    call: () => Promise<unknown>,
    okTitle: string,
    okDesc: string | undefined,
    errTitle: string,
    after?: () => void,
  ) => {
    const setList = which === "in" ? setIncoming : setOutgoing;
    setRowBusy(r.id, true);
    setList((prev) => prev.filter((x) => x.id !== r.id));
    setOpenItem((cur) => (cur?.r.id === r.id ? null : cur)); // close the detail if it was open
    try {
      await call();
      toast.show({ kind: "success", title: okTitle, ...(okDesc ? { description: okDesc } : {}) });
      after?.();
    } catch {
      setList((prev) => [r, ...prev]); // rollback
      toast.show({ kind: "error", title: errTitle, description: "もう一度お試しください。" });
    } finally {
      setRowBusy(r.id, false);
    }
  };

  const onAccept = (r: task.TaskRequest) =>
    act(r, "in", () => acceptTaskRequest(client, r.id, { version: r.version }),
      "依頼を承諾しました", "「タスクを受け負った」として自分のタスクに追加されました。", "承諾に失敗しました", onChanged);
  const onDecline = (r: task.TaskRequest) =>
    act(r, "in", () => declineTaskRequest(client, r.id, { version: r.version }), "依頼を却下しました", undefined, "却下に失敗しました");
  const onCancel = (r: task.TaskRequest) =>
    act(r, "out", () => cancelTaskRequest(client, r.id, { version: r.version }), "依頼を取り消しました", undefined, "取り消しに失敗しました");

  // 保存: commit the dialog's edits as an optimistic session-local draft (see RequestDraft).
  // The title also mirrors back onto the request row so the card + list update immediately.
  const onSaveDraft = (r: task.TaskRequest, dir: Dir, next: RequestDraft) => {
    setDrafts((prev) => new Map(prev).set(r.id, next));
    const setList = dir === "in" ? setIncoming : setOutgoing;
    setList((prev) =>
      prev.map((x) =>
        x.id === r.id
          ? { ...x, title: next.title, description: next.description === "" ? null : next.description, priority: next.priority, dueAt: isoFromDateInput(next.due) }
          : x,
      ),
    );
    toast.show({ kind: "success", title: "変更を保存しました" });
  };

  if (loading) {
    return (
      <div className={styles.chatInbox} data-testid="fe4-request-inbox-loading" aria-hidden>
        <div className={`${styles.chatSkeleton} ${styles.chatSkeletonRight}`} />
        <div className={`${styles.chatSkeleton} ${styles.chatSkeletonLeft}`} />
        <div className={`${styles.chatSkeleton} ${styles.chatSkeletonRight}`} />
      </div>
    );
  }

  const nameOf = (id: common.UserId) => displayName(users, id);
  const titleOf = (r: task.TaskRequest) => drafts.get(r.id)?.title ?? r.title;

  if (timeline.length === 0) {
    return (
      <div className={styles.chatEmpty} data-testid="fe4-request-inbox-empty">
        <p className={styles.chatEmptyTitle}>やりとり中の依頼はありません</p>
        <p className={styles.chatEmptyHint}>「＋ タスクを依頼」から誰かに送ると、ここにやりとりが並びます。</p>
      </div>
    );
  }

  return (
    <section className={styles.chatInbox} data-testid="fe4-request-inbox" aria-label="送る・受け取る（依頼のやりとり）">
      <ol className={styles.chatTimeline}>
        {timeline.map((item) => {
          const { r, dir } = item;
          const isSelf = dir === "in"; // ボールは自分 → 右
          // 相手（カードに映る人）: 受け取り=依頼者 / 送り=受け手
          const counterpartId = isSelf ? r.fromUserId : r.toUserId;
          const counterpart = nameOf(counterpartId);
          const rowClass = `${styles.chatRow} ${isSelf ? styles.chatRowRight : styles.chatRowLeft}`;
          const testId = isSelf ? `fe4-request-in-${r.id}` : `fe4-request-out-${r.id}`;
          return (
            <li key={r.id} className={rowClass} data-testid={testId} data-side={isSelf ? "self" : "other"}>
              {/* 自分が渡した依頼 (out) は、自分側(右)に ← を描いて「自分が渡した」を一目で示す。 */}
              {!isSelf && (
                <span className={styles.chatHandoff} aria-label="あなたが渡した依頼" title="あなたが渡した依頼">
                  <span className={styles.chatHandoffArrow} aria-hidden>←</span>
                </span>
              )}
              <button
                type="button"
                className={styles.chatCard}
                onClick={() => setOpenItem(item)}
                data-testid={`fe4-request-card-${r.id}`}
                aria-label={`${counterpart} ${isSelf ? "からの依頼" : "への依頼"}: ${titleOf(r)}（詳細を開く）`}
              >
                <span className={styles.chatWho}>
                  <Avatar name={counterpart} size="sm" testId={`fe4-request-avatar-${r.id}`} />
                  <span className={styles.chatWhoName}>{counterpart}</span>
                </span>
                <span className={styles.chatCardTitle}>{titleOf(r)}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {openItem && (
        <RequestDetailDialog
          key={openItem.r.id}
          item={openItem}
          counterpartName={nameOf(openItem.dir === "in" ? openItem.r.fromUserId : openItem.r.toUserId)}
          seed={drafts.get(openItem.r.id) ?? draftFromRequest(openItem.r)}
          busy={busy.has(openItem.r.id)}
          onClose={() => setOpenItem(null)}
          onSave={(next) => onSaveDraft(openItem.r, openItem.dir, next)}
          onAccept={() => onAccept(openItem.r)}
          onDecline={() => onDecline(openItem.r)}
          onCancel={() => onCancel(openItem.r)}
        />
      )}
    </section>
  );
}

interface RequestDetailDialogProps {
  item: ChatItem;
  counterpartName: string;
  seed: RequestDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (next: RequestDraft) => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
}

/**
 * 詳細ダイヤログ（中央モーダル）— ガントのタスク詳細(TaskDetailPanel)と同じ編集体験を、
 * サイドバーではなく中央ダイヤログに載せたもの。フィールド群は同じ @dub/ui プリミティブ
 * (TextField/Select/Textarea) ＋ 同じ DateField / AttachmentField / CSS クラスで統一。
 * タイトル/ステータス/優先度/開始日/期日/詳細/📎添付をその場で編集（楽観的・セッション内）し、
 * フッターに承諾/却下（受け取り側）・取消（送り側）＋保存を置く。
 */
function RequestDetailDialog({ item, counterpartName, seed, busy, onClose, onSave, onAccept, onDecline, onCancel }: RequestDetailDialogProps) {
  const { r, dir } = item;
  const isSelf = dir === "in";
  const toast = useToast();

  const [title, setTitle] = useState(seed.title);
  const [description, setDescription] = useState(seed.description);
  const [priority, setPriority] = useState<task.TaskPriority>(seed.priority);
  const [status, setStatus] = useState<task.TaskStatus>(seed.status);
  const [start, setStart] = useState<string | null>(seed.start);
  const [due, setDue] = useState<string | null>(seed.due);
  const [attachments, setAttachments] = useState<AttachmentChip[]>(seed.attachments);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const initial = useRef(seed);

  const dirty =
    title !== initial.current.title ||
    description !== initial.current.description ||
    priority !== initial.current.priority ||
    status !== initial.current.status ||
    start !== initial.current.start ||
    due !== initial.current.due ||
    attachments !== initial.current.attachments;

  const save = () => {
    const next: RequestDraft = { title, description, priority, status, start, due, attachments };
    initial.current = next;
    onSave(next);
  };

  // 📎添付: file → self-contained data URL chip (同 マイタスク発行/詳細の $0 パス), or external URL.
  //  Request にはまだタスクが無い(承認前)ため /tasks/:id/attachments は叩けない → セッション内ローカル。
  const addFiles = async (list: FileList) => {
    if (list.length === 0) return;
    setAttachError(null);
    setAttachBusy(true);
    try {
      for (const file of Array.from(list)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setAttachError(`「${file.name}」は1MBを超えています（添付できるのは1MBまで）`);
          continue;
        }
        const dataUrl = await readFileAsDataUrl(file);
        setAttachments((prev) => [
          { id: `att_${Date.now()}_${prev.length}`, kind: "file", name: file.name, href: dataUrl, download: true, sizeBytes: file.size },
          ...prev,
        ]);
        toast.show({ kind: "success", title: `「${file.name}」を添付しました` });
      }
    } finally {
      setAttachBusy(false);
    }
  };
  const addUrl = (url: string, name: string) => {
    setAttachError(null);
    setAttachments((prev) => [{ id: `att_${Date.now()}_${prev.length}`, kind: "url", name: name || url, href: url }, ...prev]);
    toast.show({ kind: "success", title: "URLを添付しました" });
  };
  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const footer = (
    <div className={styles.requestDetailFooter}>
      {isSelf ? (
        <Button variant="ghost" onClick={onDecline} disabled={busy} testId={`fe4-request-decline-${r.id}`}>
          却下
        </Button>
      ) : (
        <Button variant="ghost" onClick={onCancel} disabled={busy} testId={`fe4-request-cancel-${r.id}`}>
          依頼を取り消す
        </Button>
      )}
      <div className={styles.requestDetailFooterEnd}>
        <Button variant="secondary" onClick={save} disabled={busy || !dirty} testId={`fe4-request-save-${r.id}`}>
          保存
        </Button>
        {isSelf && (
          <Button onClick={onAccept} loading={busy} testId={`fe4-request-accept-${r.id}`}>
            承諾
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal open onClose={onClose} title="依頼の詳細" size="md" footer={footer} testId={`fe4-request-detail-${r.id}`}>
      <div className={styles.detailPanelBody} aria-label="依頼の詳細">
        {/* 相手 + 承認状態（TaskRequest 固有: 相手/状態/依頼日） */}
        <div className={styles.requestDetailWho}>
          <Avatar name={counterpartName} size="md" />
          <div>
            <p className={styles.chatDetailName}>{counterpartName}</p>
            <p className={styles.chatDetailRel}>{isSelf ? "さんからの依頼" : "さんへの依頼"}</p>
          </div>
        </div>
        <div className={styles.panelHeadInfo}>
          <span className={`${styles.chatDetailState} ${isSelf ? styles.chatDetailStateSelf : styles.chatDetailStateOther}`}>
            {isSelf ? "あなたの承諾待ち" : "相手の承諾待ち"}
          </span>
          <span className={styles.chatDetailRel}>依頼日 {formatTime(r.createdAt)}</span>
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`fe4-request-title-${r.id}`}>
            タイトル
          </label>
          <TextField id={`fe4-request-title-${r.id}`} value={title} onChange={setTitle} testId={`fe4-request-detail-title-${r.id}`} />
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`fe4-request-status-${r.id}`}>
              ステータス
            </label>
            <Select
              id={`fe4-request-status-${r.id}`}
              value={status}
              onChange={(v) => setStatus(v as task.TaskStatus)}
              options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              testId={`fe4-request-detail-status-${r.id}`}
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`fe4-request-priority-${r.id}`}>
              優先度
            </label>
            <Select
              id={`fe4-request-priority-${r.id}`}
              value={priority}
              onChange={(v) => setPriority(v as task.TaskPriority)}
              options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              testId={`fe4-request-detail-priority-${r.id}`}
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`fe4-request-start-${r.id}`}>
              開始日
            </label>
            <DateField id={`fe4-request-start-${r.id}`} value={start} onChange={setStart} testId={`fe4-request-detail-start-${r.id}`} />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`fe4-request-due-${r.id}`}>
              期日
            </label>
            <DateField id={`fe4-request-due-${r.id}`} value={due} onChange={setDue} testId={`fe4-request-detail-due-${r.id}`} />
          </div>
        </div>

        {/* 📎添付（ファイル・URL）: ガント詳細と同じ AttachmentField。承認前はセッション内ローカル。 */}
        <AttachmentField
          chips={attachments}
          canWrite
          busy={attachBusy}
          error={attachError}
          onPickFiles={(l) => void addFiles(l)}
          onAddUrl={addUrl}
          onRemove={removeAttachment}
          testIdPrefix={`fe4-request-attach-${r.id}`}
        />

        {/* 詳細（メモ）: free-text body/notes（ガント詳細と同じ Textarea・最下部）。 */}
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`fe4-request-desc-${r.id}`}>
            詳細
          </label>
          <Textarea
            id={`fe4-request-desc-${r.id}`}
            value={description}
            onChange={setDescription}
            rows={4}
            placeholder="依頼の背景・手順・補足などを書けます"
            testId={`fe4-request-detail-desc-${r.id}`}
          />
        </div>
      </div>
    </Modal>
  );
}
