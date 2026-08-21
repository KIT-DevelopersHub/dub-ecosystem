import { useCallback, useEffect, useMemo, useState } from "react";
import type { common, identity, task } from "@dub/types";
import { Avatar, Badge, Button, Modal, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTaskRequests, acceptTaskRequest, declineTaskRequest, cancelTaskRequest, resolveUsers } from "../api/endpoints";
import { createUserCache, ensureUsers, displayName, type UserCache } from "../domain/user-cache";
import { PRIORITY_LABEL } from "../domain/task-form";
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

const PRIORITY_TONE: Record<task.TaskPriority, "neutral" | "info" | "warning" | "danger"> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  urgent: "danger",
};

/** 依頼日を短く。今日なら HH:mm、それ以外は M/D。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 期限を YYYY/M/D で。 */
function formatDue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 送る・受け取る — the マイタスク request timeline, laid out like a chat (LINE/TaskTalk 風)。
 * すべての依頼を1本の時系列に並べ、「いまボールを持っている人」で左右を決める:
 *   - 他人から自分に依頼され承諾/却下する番 → ボールは自分 → 右（自分がボール）
 *   - 自分が誰かに依頼して相手の承諾待ち   → ボールは相手 → 左（渡したので自分側に ←）
 * カード上はタイトルと相手アイコン（＋名前）だけに絞り、本文・優先度・状態・承諾/却下/取消は
 * カードをクリックした詳細モーダルに逃がす（キュッとコンパクトに）。承諾/却下/取消でボールが
 * 移ったら行が消える（サーバーが確定・ここは楽観的にドロップして再取得）。バックエンドは不変。
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
                aria-label={`${counterpart} ${isSelf ? "からの依頼" : "への依頼"}: ${r.title}（詳細を開く）`}
              >
                <span className={styles.chatWho}>
                  <Avatar name={counterpart} size="sm" testId={`fe4-request-avatar-${r.id}`} />
                  <span className={styles.chatWhoName}>{counterpart}</span>
                </span>
                <span className={styles.chatCardTitle}>{r.title}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {openItem && (
        <RequestDetailModal
          item={openItem}
          counterpartName={nameOf(openItem.dir === "in" ? openItem.r.fromUserId : openItem.r.toUserId)}
          busy={busy.has(openItem.r.id)}
          onClose={() => setOpenItem(null)}
          onAccept={() => onAccept(openItem.r)}
          onDecline={() => onDecline(openItem.r)}
          onCancel={() => onCancel(openItem.r)}
        />
      )}
    </section>
  );
}

interface RequestDetailModalProps {
  item: ChatItem;
  counterpartName: string;
  busy: boolean;
  onClose: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
}

/** クリックで開く詳細。カードに出さない情報（本文・優先度・状態・アクション）をここに集約。 */
function RequestDetailModal({ item, counterpartName, busy, onClose, onAccept, onDecline, onCancel }: RequestDetailModalProps) {
  const { r, dir } = item;
  const isSelf = dir === "in";
  const due = formatDue(r.dueAt);
  const footer = isSelf ? (
    <div className={styles.chatDetailActions}>
      <Button variant="ghost" onClick={onDecline} disabled={busy} testId={`fe4-request-decline-${r.id}`}>
        却下
      </Button>
      <Button onClick={onAccept} loading={busy} testId={`fe4-request-accept-${r.id}`}>
        承諾
      </Button>
    </div>
  ) : (
    <div className={styles.chatDetailActions}>
      <Button variant="ghost" onClick={onCancel} disabled={busy} testId={`fe4-request-cancel-${r.id}`}>
        依頼を取り消す
      </Button>
    </div>
  );
  return (
    <Modal open onClose={onClose} title={r.title} size="sm" footer={footer} testId={`fe4-request-detail-${r.id}`}>
      <div className={styles.chatDetail}>
        <div className={styles.chatDetailWho}>
          <Avatar name={counterpartName} size="md" />
          <div>
            <p className={styles.chatDetailName}>{counterpartName}</p>
            <p className={styles.chatDetailRel}>{isSelf ? "さんからの依頼" : "さんへの依頼"}</p>
          </div>
        </div>

        <dl className={styles.chatDetailMeta}>
          <div className={styles.chatDetailMetaRow}>
            <dt>状態</dt>
            <dd>
              <span className={`${styles.chatDetailState} ${isSelf ? styles.chatDetailStateSelf : styles.chatDetailStateOther}`}>
                {isSelf ? "あなたの承諾待ち" : "相手の承諾待ち"}
              </span>
            </dd>
          </div>
          <div className={styles.chatDetailMetaRow}>
            <dt>優先度</dt>
            <dd><Badge tone={PRIORITY_TONE[r.priority]}>{PRIORITY_LABEL[r.priority]}</Badge></dd>
          </div>
          {due && (
            <div className={styles.chatDetailMetaRow}>
              <dt>期限</dt>
              <dd>{due}</dd>
            </div>
          )}
          <div className={styles.chatDetailMetaRow}>
            <dt>依頼日</dt>
            <dd>{formatTime(r.createdAt)}</dd>
          </div>
        </dl>

        {r.description ? (
          <div className={styles.chatDetailBody}>
            <p className={styles.chatDetailBodyLabel}>内容</p>
            <p className={styles.chatDetailBodyText}>{r.description}</p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
