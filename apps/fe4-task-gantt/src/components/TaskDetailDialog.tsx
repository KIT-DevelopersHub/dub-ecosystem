import { useEffect, useState } from "react";
import type { task, common } from "@dub/types";
import { Modal, Badge, Button, SkeletonList, type BadgeTone } from "@dub/ui";
import type { UserCache } from "../domain/user-cache";
import { useApiClient } from "../api/client-context";
import { listTaskAttachments } from "../api/endpoints";
import { isOverdue } from "../domain/my-tasks";
import { PRIORITY_LABEL } from "../domain/task-form";
import { FromToCell } from "./FromToCell";
import { TaskStatusBadge } from "./TaskStatusBadge";
import styles from "../styles/app.module.css";

function humanSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentsSection({ taskId }: { taskId: common.TaskId }) {
  const client = useApiClient();
  const [items, setItems] = useState<task.TaskAttachment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setItems(null);
    setFailed(false);
    listTaskAttachments(client, taskId)
      .then((res) => {
        if (live) setItems(res.items);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [client, taskId]);

  return (
    <section className={styles.detailSection} data-testid="fe4-mytask-detail-attachments">
      <h3 className={styles.detailHeading}>添付</h3>
      {items === null && !failed ? (
        <SkeletonList rows={2} />
      ) : failed ? (
        <p className={styles.detailEmpty}>添付を読み込めませんでした。</p>
      ) : items && items.length > 0 ? (
        <ul className={styles.attachViewList}>
          {items.map((a) => {
            const isImage = (a.mimeType ?? "").startsWith("image/");
            return (
              <li key={a.id} className={styles.attachViewItem}>
                {a.kind === "file" && isImage ? (
                  <a href={a.url} target="_blank" rel="noreferrer" title={a.name}>
                    <img src={a.url} alt={a.name} className={styles.attachViewImage} />
                  </a>
                ) : (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    {...(a.kind === "file" ? { download: a.name } : {})}
                    className={styles.attachViewLink}
                    data-testid={`fe4-mytask-detail-attach-${a.kind}`}
                  >
                    <span aria-hidden>{a.kind === "file" ? "📎" : "🔗"}</span>
                    <span className={styles.attachViewName}>{a.name}</span>
                    {a.sizeBytes !== null && <span className={styles.attachViewSize}>{humanSize(a.sizeBytes)}</span>}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.detailEmpty} data-testid="fe4-mytask-detail-attachments-empty">
          添付はありません。
        </p>
      )}
    </section>
  );
}

const PRIORITY_TONE: Record<task.TaskPriority, BadgeTone> = {
  urgent: "danger",
  high: "warning",
  medium: "neutral",
  low: "neutral",
};

function formatDue(iso: common.ISODateTime | null): string {
  return iso ? iso.slice(0, 10) : "期限なし";
}

export interface TaskDetailDialogProps {
  /** the task to show; null closes the dialog. */
  task: task.Task | null;
  users: UserCache;
  teamNames: Map<common.TeamId, string>;
  onClose: () => void;
  /** optional escape hatch: open the full ガント workspace for this task. */
  onOpenWorkspace?: (task: task.Task) => void;
  now?: number;
}

/**
 * Task detail dialog (feedback #2): clicking a row opens this instead of navigating
 * away, so the 内容(description) captured at 発行 is finally readable from the list.
 * The task is already loaded in the list, so the dialog renders instantly (no fetch,
 * no skeleton) — the optimistic-UI principle: show what we already have at once.
 * The old navigate-to-workspace behavior is preserved as an explicit 「ガントで開く」
 * button so the row click no longer conflicts with it.
 */
export function TaskDetailDialog({ task, users, teamNames, onClose, onOpenWorkspace, now = Date.now() }: TaskDetailDialogProps) {
  const t = task;
  const overdue = t ? isOverdue(t, now) : false;
  const team = t?.teamId ? teamNames.get(t.teamId) ?? null : null;
  const hasDescription = !!t?.description && t.description.trim().length > 0;

  return (
    <Modal
      open={t !== null}
      onClose={onClose}
      title={t?.title ?? "タスクの詳細"}
      size="md"
      testId="fe4-mytask-detail"
      footer={
        <div className={styles.modalFooter}>
          {t && onOpenWorkspace && (
            <Button variant="ghost" onClick={() => onOpenWorkspace(t)} testId="fe4-mytask-detail-open">
              ガントで開く
            </Button>
          )}
          <Button onClick={onClose} testId="fe4-mytask-detail-close">
            閉じる
          </Button>
        </div>
      }
    >
      {t && (
        <div className={styles.detailBody} data-testid="fe4-mytask-detail-body">
          <section className={styles.detailSection}>
            <h3 className={styles.detailHeading}>詳細</h3>
            {hasDescription ? (
              <p className={styles.detailDesc} data-testid="fe4-mytask-detail-description">
                {t.description}
              </p>
            ) : (
              <p className={styles.detailEmpty} data-testid="fe4-mytask-detail-description-empty">
                詳細は登録されていません。
              </p>
            )}
          </section>

          <dl className={styles.detailGrid}>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>依頼 → 担当</dt>
              <dd className={styles.detailValue}>
                <FromToCell fromId={t.createdBy ?? null} toId={t.assigneeId} users={users} testId="fe4-mytask-detail-fromto" />
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>状態</dt>
              <dd className={styles.detailValue}>
                <TaskStatusBadge status={t.status} />
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>優先度</dt>
              <dd className={styles.detailValue}>
                <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Badge>
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>終了日</dt>
              <dd className={`${styles.detailValue} ${overdue ? styles.dueOverdue : ""}`} data-testid="fe4-mytask-detail-due">
                {formatDue(t.dueAt)}
                {overdue && <span className={styles.overdueTag}> 期限切れ</span>}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailLabel}>チーム</dt>
              <dd className={styles.detailValue}>
                {team ? <Badge tone="info">{team}</Badge> : <span className={styles.muted}>―</span>}
              </dd>
            </div>
          </dl>

          <AttachmentsSection taskId={t.id} />
        </div>
      )}
    </Modal>
  );
}
