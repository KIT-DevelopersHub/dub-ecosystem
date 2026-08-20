import { useCallback, useEffect, useState } from "react";
import type { common, identity, task } from "@dub/types";
import { Button, useToast } from "@dub/ui";
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

/**
 * 受け取る — the マイタスク request inbox. Shows 受け取った依頼 (承諾/却下) and 送った依頼
 * (取消), all pending. Accepting materialises the receiver's task ("タスクを受け負った") and
 * the requester's tracking task ("タスクをお願いした") + the arrow-less cross-link — the
 * server does that; here we optimistically drop the row and refresh. Renders nothing when
 * there is no pending request either way.
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
    which: "in" | "out",
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
      <div className={styles.requestInbox} data-testid="fe4-request-inbox-loading" aria-hidden>
        <div className={styles.requestSkeleton} />
        <div className={styles.requestSkeleton} />
      </div>
    );
  }
  if (incoming.length === 0 && outgoing.length === 0) return null;

  const nameOf = (id: common.UserId) => displayName(users, id);

  return (
    <div className={styles.requestInbox} data-testid="fe4-request-inbox">
      {incoming.length > 0 && (
        <section className={styles.requestGroup}>
          <h2 className={styles.requestSectionTitle}>
            受け取った依頼 <span className={styles.requestCount}>{incoming.length}</span>
          </h2>
          <ul className={styles.requestList}>
            {incoming.map((r) => (
              <li key={r.id} className={styles.requestCard} data-testid={`fe4-request-in-${r.id}`}>
                <div className={styles.requestMain}>
                  <p className={styles.requestTitle}>{r.title}</p>
                  <p className={styles.requestMeta}>
                    <strong>{nameOf(r.fromUserId)}</strong> さんから ・ 優先度 {PRIORITY_LABEL[r.priority]}
                  </p>
                </div>
                <div className={styles.requestActions}>
                  <Button variant="ghost" onClick={() => onDecline(r)} disabled={busy.has(r.id)} testId={`fe4-request-decline-${r.id}`}>
                    却下
                  </Button>
                  <Button onClick={() => onAccept(r)} loading={busy.has(r.id)} testId={`fe4-request-accept-${r.id}`}>
                    承諾
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {outgoing.length > 0 && (
        <section className={styles.requestGroup}>
          <h2 className={styles.requestSectionTitle}>
            送った依頼（承認待ち） <span className={styles.requestCount}>{outgoing.length}</span>
          </h2>
          <ul className={styles.requestList}>
            {outgoing.map((r) => (
              <li key={r.id} className={styles.requestCard} data-testid={`fe4-request-out-${r.id}`}>
                <div className={styles.requestMain}>
                  <p className={styles.requestTitle}>{r.title}</p>
                  <p className={styles.requestMeta}>
                    <strong>{nameOf(r.toUserId)}</strong> さんへ ・ 承認待ち
                  </p>
                </div>
                <div className={styles.requestActions}>
                  <Button variant="ghost" onClick={() => onCancel(r)} disabled={busy.has(r.id)} testId={`fe4-request-cancel-${r.id}`}>
                    取消
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
