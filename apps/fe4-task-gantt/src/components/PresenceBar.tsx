// PresenceBar — the Google-Docs-style row of "who else is here" avatars for the gantt.
// Shows every OTHER user currently viewing this event's gantt as a coloured initial chip
// (deterministic colour per user), deduped per user, and collapses overflow into a "+N"
// chip. A small connection dot conveys the realtime status. View-only; all state comes
// from useGanttRealtime. The local user ("you") is excluded — this bar answers "who else
// is looking at this right now".
import type { common, gantt } from "@dub/types";
import { avatarColor, avatarInitials, presenceLabel } from "../domain/presence";
import type { RealtimeStatus } from "../api/useGanttRealtime";
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
  // Only OTHERS (自分以外), deduped defensively, ordered by label so the row is stable.
  const seen = new Set<common.UserId>();
  const others = presence
    .filter((u) => u.userId !== selfUserId && !seen.has(u.userId) && (seen.add(u.userId), true))
    .sort((a, b) => presenceLabel(a, displayNameById).localeCompare(presenceLabel(b, displayNameById), "ja"));

  // Nothing to show and connected ⇒ render nothing (no empty box). While connecting show
  // a quiet status so the feature is discoverable.
  if (others.length === 0 && status === "open") return null;

  const shown = others.slice(0, max);
  const overflow = others.length - shown.length;

  return (
    <div className={styles.bar} data-testid="fe4-presence-bar">
      <span className={styles.status} title={STATUS_LABEL[status]}>
        <span className={`${styles.dot} ${styles[status]}`} aria-hidden />
        {others.length > 0 ? (
          <span>他 {others.length} 人が閲覧中</span>
        ) : (
          <span>{STATUS_LABEL[status]}</span>
        )}
      </span>
      {shown.length > 0 && (
        <div className={styles.avatars} role="list" aria-label="このガントを見ている他のメンバー">
          {shown.map((u) => {
            const label = presenceLabel(u, displayNameById);
            return (
              <span
                key={u.userId}
                role="listitem"
                className={styles.avatar}
                style={{ background: avatarColor(u.userId) }}
                title={`${label} — 閲覧中`}
                aria-label={`${label} — 閲覧中`}
                data-testid={`fe4-presence-avatar-${u.userId}`}
              >
                {avatarInitials(label)}
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
