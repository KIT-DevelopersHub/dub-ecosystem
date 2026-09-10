// PresenceBar — the Google-Docs-style cluster of "who is here" avatars for the gantt.
// Mirrors the active-viewer chips Docs/Sheets show top-right: overlapping circular
// avatars, each ringed in the person's deterministic colour (photo if we ever carry one,
// initials otherwise), the local user marked "（あなた）", editors shown with a warm accent
// ring, and the overflow collapsed into a "+N" chip. Clicking the cluster (or +N) opens a roster
// popover that lists everyone by name. A small dot conveys the realtime connection state.
// View-only: every bit of state comes from useGanttRealtime — this component just paints.
import { useEffect, useId, useRef, useState } from "react";
import type { common, gantt } from "@dub/types";
import { avatarColor, avatarInitials, presenceLabel } from "../realtime/presence";
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Close the roster popover on outside-click or Escape (Docs behaviour).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Sort self first so "あなた" is always the anchor chip, then editors, then by label.
  const users = [...presence].sort((a, b) => {
    if (a.userId === selfUserId) return -1;
    if (b.userId === selfUserId) return 1;
    if (a.editing !== b.editing) return a.editing ? -1 : 1;
    return presenceLabel(a, displayNameById).localeCompare(presenceLabel(b, displayNameById), "ja");
  });
  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;
  const editingCount = users.filter((u) => u.editing).length;
  const hasRoster = users.length > 0;

  return (
    <div className={styles.bar} data-testid="fe4-presence-bar" ref={rootRef}>
      <span className={styles.status} title={STATUS_LABEL[status]}>
        <span className={`${styles.dot} ${styles[status]}`} aria-hidden />
        {hasRoster ? (
          <span>
            {users.length}人が閲覧中{editingCount > 0 ? ` · ${editingCount}人が編集中` : ""}
          </span>
        ) : (
          <span>{STATUS_LABEL[status]}</span>
        )}
      </span>

      {hasRoster && (
        <button
          type="button"
          className={styles.cluster}
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`このガントを見ているメンバー ${users.length} 人。クリックで一覧を開く`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={styles.avatars} role="list" aria-label="このガントを見ているメンバー">
            {shown.map((u) => {
              const label = presenceLabel(u, displayNameById);
              const isSelf = u.userId === selfUserId;
              const color = avatarColor(u.userId);
              const title = `${label}${isSelf ? "（あなた）" : ""} — ${u.editing ? "編集中" : "閲覧中"}`;
              return (
                <span
                  key={u.userId}
                  role="listitem"
                  className={`${styles.avatar} ${u.editing ? styles.editing : ""} ${isSelf ? styles.me : ""}`}
                  // Identity colour drives BOTH the fill and the ring (via currentColor) so
                  // each person is recognisable exactly the way Docs rings its viewers.
                  style={{ color, backgroundColor: color }}
                  title={title}
                  aria-label={title}
                  data-testid={`fe4-presence-avatar-${u.userId}`}
                  data-editing={u.editing ? "true" : "false"}
                >
                  <span className={styles.initials}>{avatarInitials(label)}</span>
                </span>
              );
            })}
            {overflow > 0 && (
              <span className={styles.overflow} title={`他 ${overflow} 人`} aria-hidden>
                +{overflow}
              </span>
            )}
          </span>
        </button>
      )}

      {open && hasRoster && (
        <div className={styles.popover} id={listId} role="menu" aria-label="閲覧中のメンバー一覧">
          <p className={styles.popoverTitle}>閲覧中のメンバー（{users.length}）</p>
          <ul className={styles.popoverList}>
            {users.map((u) => {
              const label = presenceLabel(u, displayNameById);
              const isSelf = u.userId === selfUserId;
              const color = avatarColor(u.userId);
              return (
                <li key={u.userId} className={styles.popoverItem} role="menuitem">
                  <span
                    className={`${styles.miniAvatar} ${u.editing ? styles.editing : ""}`}
                    style={{ color, backgroundColor: color }}
                    aria-hidden
                  >
                    <span className={styles.initials}>{avatarInitials(label)}</span>
                  </span>
                  <span className={styles.popoverName}>
                    {label}
                    {isSelf && <span className={styles.youTag}>（あなた）</span>}
                  </span>
                  <span className={`${styles.popoverState} ${u.editing ? styles.stateEditing : ""}`}>
                    {u.editing ? "編集中" : "閲覧中"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
