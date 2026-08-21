import { useCallback, useEffect, useMemo, useState } from "react";
import type { common, identity, task } from "@dub/types";
import { Badge, Button, useToast } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTaskRequests, acceptTaskRequest, declineTaskRequest, cancelTaskRequest, resolveUsers } from "../api/endpoints";
import { createUserCache, ensureUsers, displayName, type UserCache } from "../domain/user-cache";
import { PRIORITY_LABEL } from "../domain/task-form";
import styles from "../styles/app.module.css";

export interface MyTaskRequestsProps {
  /** Seed roster so from/to names render without a round-trip when already known. */
  seedUsers: readonly identity.UserSummary[];
  /** Fired after an accept so the parent reloads its task list (the new 受け負った task appears). */
  onChanged: () => void;
}

/** Direction of a request from the current user's point of view.
 *  `in`  = 他人 → 自分 で、いま自分が承諾/却下する番   → ボールは自分   → 右の吹き出し
 *  `out` = 自分 → 他人 で、相手の承諾待ち                → ボールは相手   → 左の吹き出し */
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

/** 送信時刻を短く。今日なら HH:mm、それ以外は M/D。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 表示名の頭文字（アバターの中身）。 */
function initialOf(name: string): string {
  return name.trim().slice(0, 1) || "?";
}

/**
 * 送る・受け取る — the マイタスク request timeline, laid out like a chat (LINE/TaskTalk風).
 * すべての依頼を1本の時系列に並べ、「いまボールを持っている人」で左右を決める:
 *   - 自分が誰かに依頼して相手の承諾待ち → ボールは相手 → 左の吹き出し（相手側の色）
 *   - 他人から自分に依頼されて承諾/却下する番 → ボールは自分 → 右の吹き出し（自分側の色）
 * 承諾/却下/取消でボールが移ったら行が消える（サーバーが確定・ここは楽観的にドロップして再取得）。
 * バックエンドは一切変えない=表示レイヤのみ。pending 依頼が無ければ何も描画しない。
 */
export function MyTaskRequests({ seedUsers, onChanged }: MyTaskRequestsProps) {
  const client = useApiClient();
  const toast = useToast();
  const [incoming, setIncoming] = useState<task.TaskRequest[]>([]);
  const [outgoing, setOutgoing] = useState<task.TaskRequest[]>([]);
  const [users, setUsers] = useState<UserCache>(() => createUserCache(seedUsers));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

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
        <div className={`${styles.chatSkeleton} ${styles.chatSkeletonLeft}`} />
        <div className={`${styles.chatSkeleton} ${styles.chatSkeletonRight}`} />
        <div className={`${styles.chatSkeleton} ${styles.chatSkeletonLeft}`} />
      </div>
    );
  }
  if (timeline.length === 0) return null;

  const nameOf = (id: common.UserId) => displayName(users, id);

  return (
    <section className={styles.chatInbox} data-testid="fe4-request-inbox" aria-label="送る・受け取る（依頼のやりとり）">
      <header className={styles.chatHeader}>
        <h2 className={styles.chatHeaderTitle}>送る・受け取る</h2>
        <p className={styles.chatHeaderHint}>
          <span className={styles.chatLegendSelf} aria-hidden />
          右＝あなたの番（{incoming.length}）
          <span className={styles.chatLegendOther} aria-hidden />
          左＝相手の番（{outgoing.length}）
        </p>
      </header>

      <ol className={styles.chatTimeline}>
        {timeline.map(({ r, dir }) => {
          const isSelf = dir === "in"; // ボールは自分 → 右
          // 相手（吹き出しに映る人）: 受け取り=依頼者 / 送り=受け手
          const counterpartId = isSelf ? r.fromUserId : r.toUserId;
          const counterpart = nameOf(counterpartId);
          const rowClass = `${styles.chatRow} ${isSelf ? styles.chatRowRight : styles.chatRowLeft}`;
          const bubbleClass = `${styles.chatBubble} ${isSelf ? styles.chatBubbleSelf : styles.chatBubbleOther}`;
          const testId = isSelf ? `fe4-request-in-${r.id}` : `fe4-request-out-${r.id}`;
          return (
            <li key={r.id} className={rowClass} data-testid={testId} data-side={isSelf ? "self" : "other"}>
              <div className={styles.chatAvatar} aria-hidden>
                {initialOf(counterpart)}
              </div>
              <div className={styles.chatBubbleWrap}>
                <div className={styles.chatByline}>
                  <span className={styles.chatWho}>
                    <span className={styles.chatName}>{counterpart}</span>
                    <span className={styles.chatRel}>{isSelf ? "さんから" : "さんへ"}</span>
                  </span>
                  <time className={styles.chatTime} dateTime={r.createdAt}>{formatTime(r.createdAt)}</time>
                </div>
                <div className={bubbleClass}>
                  <p className={styles.chatTitle}>{r.title}</p>
                  {r.description ? <p className={styles.chatDesc}>{r.description}</p> : null}
                  <div className={styles.chatBadges}>
                    <Badge tone={PRIORITY_TONE[r.priority]}>優先度 {PRIORITY_LABEL[r.priority]}</Badge>
                    <span className={styles.chatStatus}>{isSelf ? "あなたの承諾待ち" : "相手の承諾待ち"}</span>
                  </div>
                  {isSelf ? (
                    <div className={styles.chatActions}>
                      <Button variant="ghost" size="sm" onClick={() => onDecline(r)} disabled={busy.has(r.id)} testId={`fe4-request-decline-${r.id}`}>
                        却下
                      </Button>
                      <Button size="sm" onClick={() => onAccept(r)} loading={busy.has(r.id)} testId={`fe4-request-accept-${r.id}`}>
                        承諾
                      </Button>
                    </div>
                  ) : (
                    <div className={styles.chatActions}>
                      <Button variant="ghost" size="sm" onClick={() => onCancel(r)} disabled={busy.has(r.id)} testId={`fe4-request-cancel-${r.id}`}>
                        取消
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
