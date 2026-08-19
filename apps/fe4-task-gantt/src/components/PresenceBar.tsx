// PresenceBar — the Google-Docs-style row of "who is here" avatars for the gantt. Shows
// each present user as a coloured initial chip (deterministic colour per user), rings the
// ones currently editing, marks the local user ("あなた"), and collapses the overflow into
// a "+N" chip. A small connection dot conveys the realtime status. View-only; all state
// comes from useGanttRealtime.
import type { common, gantt } from "@dub/types";
import { avatarColor, avatarInitials, presenceLabel } from "../realtime/presence";
import type { RealtimeStatus } from "../realtime/gantt-rt-client";
import styles from "./PresenceBar.module.css";

export interface PresenceBarProps {
  presence: readonly gantt.GanttPresenceUser[];
  status: RealtimeStatus;
  selfUserId: common.UserId | null;
  /** Roster fallback for display names not carried on the presence frame. */
  displayNameById: ReadonlyMap<common.UserId, string>;
  /** Max avatars before collapsing into "+N" (default 5). */
  max?: number;
}

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  connecting: "接続中",
  open: "接続済み",
  reconnecting: "再接続中",
  closed: "オフライン",
};

export function PresenceBar({ presence, status, selfUserId, displayNameById, max = 5 }: PresenceBarProps) {
  // Sort self first so "あなた" is always the anchor chip, then by label.
  const users = [...presence].sort((a, b) => {
    if (a.userId === selfUserId) return -1;
    if (b.userId === selfUserId) return 1;
    return presenceLabel(a, displayNameById).localeCompare(presenceLabel(b, displayNameById), "ja");
  });
  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;
  const editingCount = users.filter((u) => u.editing).length;

  return (
    <div className={styles.bar} data-testid="fe4-presence-bar">
      <span className={styles.status} title={STATUS_LABEL[status]}>
        <span className={`${styles.dot} ${styles[status]}`} aria-hidden />
        {users.length > 0 ? (
          <span>
            {users.length}人が閲覧中{editingCount > 0 ? ` · ${editingCount}人が編集中` : ""}
          </span>
        ) : (
          <span>{STATUS_LABEL[status]}</span>
        )}
      </span>
      {shown.length > 0 && (
        <div className={styles.avatars} role="list" aria-label="このガントを見ているメンバー">
          {shown.map((u) => {
            const label = presenceLabel(u, displayNameById);
            const isSelf = u.userId === selfUserId;
            const title = `${label}${isSelf ? "（あなた）" : ""} — ${u.editing ? "編集中" : "閲覧中"}`;
            return (
              <span
                key={u.userId}
                role="listitem"
                className={`${styles.avatar} ${u.editing ? styles.editing : ""} ${isSelf ? styles.me : ""}`}
                style={{ background: avatarColor(u.userId) }}
                title={title}
                aria-label={title}
                data-testid={`fe4-presence-avatar-${u.userId}`}
                data-editing={u.editing ? "true" : "false"}
              >
                {avatarInitials(label)}
                {u.editing && (
                  <span className={styles.badge} aria-hidden>
                    編集
                  </span>
                )}
              </span>
            );
          })}
          {overflow > 0 && (
            <span className={styles.overflow} title={`他 ${overflow} 人`} aria-label={`他 ${overflow} 人`}>
              +{overflow}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
