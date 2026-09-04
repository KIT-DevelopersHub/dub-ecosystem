// PresenceBar — the Google-Docs-style row of "who is here" avatars for the gantt.
// Shows EVERY user currently viewing this event's gantt — INCLUDING you — as a coloured
// initial chip (deterministic colour per user), deduped per user (a user's multiple tabs
// collapse to one avatar), and collapses overflow into a "+N" chip. You are pinned first
// and badged "（あなた）" so a single tab still shows itself. A small connection dot conveys
// the realtime status. View-only; all state comes from useGanttRealtime. This bar answers
// "who (myself included) is looking at this right now".
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
  const isSelf = (u: gantt.GanttPresenceUser) => selfUserId != null && u.userId === selfUserId;

  // The DO already fans self out in its snapshot; inject defensively so a SINGLE tab still
  // sees itself even before/around a frame race (接続時の self をローカルで補完). Only when
  // truly connected — while (re)connecting the roster is unknown, so we don't fake a self.
  const withSelf: gantt.GanttPresenceUser[] =
    selfUserId != null && status === "open" && !presence.some((u) => u.userId === selfUserId)
      ? [{ userId: selfUserId }, ...presence]
      : [...presence];

  // Everyone here (自分含む全員), deduped per user (multi-tab ⇒ one avatar). Self is pinned
  // first; the rest ordered by label so the row is stable.
  const seen = new Set<common.UserId>();
  const viewers = withSelf
    .filter((u) => !seen.has(u.userId) && (seen.add(u.userId), true))
    .sort((a, b) => {
      if (isSelf(a) !== isSelf(b)) return isSelf(a) ? -1 : 1;
      return presenceLabel(a, displayNameById).localeCompare(presenceLabel(b, displayNameById), "ja");
    });

  // Nobody resolved yet and connected ⇒ render nothing (no empty box). While connecting
  // show a quiet status so the feature is discoverable.
  if (viewers.length === 0 && status === "open") return null;

  const shown = viewers.slice(0, max);
  const overflow = viewers.length - shown.length;

  return (
    <div className={styles.bar} data-testid="fe4-presence-bar">
      <span className={styles.status} title={STATUS_LABEL[status]}>
        <span className={`${styles.dot} ${styles[status]}`} aria-hidden />
        {viewers.length > 0 ? (
          <span>{viewers.length} 人が閲覧中</span>
        ) : (
          <span>{STATUS_LABEL[status]}</span>
        )}
      </span>
      {shown.length > 0 && (
        <div className={styles.avatars} role="list" aria-label="このガントを見ているメンバー">
          {shown.map((u) => {
            const self = isSelf(u);
            const label = presenceLabel(u, displayNameById);
            const full = self ? `${label}（あなた）` : label;
            return (
              <span
                key={u.userId}
                role="listitem"
                className={`${styles.avatar}${self ? ` ${styles.self}` : ""}`}
                style={{ background: avatarColor(u.userId) }}
                title={`${full} — 閲覧中`}
                aria-label={`${full} — 閲覧中`}
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
