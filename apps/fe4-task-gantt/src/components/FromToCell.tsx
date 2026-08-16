import type { common } from "@dub/types";
import { Avatar } from "@dub/ui";
import type { UserCache } from "../domain/user-cache";
import { displayName } from "../domain/user-cache";
import styles from "../styles/app.module.css";

export interface FromToCellProps {
  /** requester — task.createdBy (the "from"). */
  fromId: common.UserId | null;
  /** assignee — task.assigneeId (the "to"). */
  toId: common.UserId | null;
  users: UserCache;
  /** compact = avatars only (with names as tooltips); default shows names too. */
  compact?: boolean;
  testId?: string;
}

function Party({ id, users, compact }: { id: common.UserId | null; users: UserCache; compact?: boolean }) {
  const name = displayName(users, id);
  const src = id ? users.get(id)?.avatarUrl ?? undefined : undefined;
  return (
    <span className={styles.party}>
      <Avatar name={name} src={src} size="sm" />
      {!compact && <span className={styles.partyName}>{name}</span>}
    </span>
  );
}

/** Arrow glyph rendered as SVG so it stays crisp and theme-aware. */
function Arrow() {
  return (
    <svg className={styles.fromToArrow} width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none">
      <path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * "誰から誰へ" — renders requester → assignee so a task's direction is legible at
 * a glance (design ask (b)). Screen readers get an explicit label.
 */
export function FromToCell({ fromId, toId, users, compact, testId }: FromToCellProps) {
  const label = `${displayName(users, fromId)} から ${displayName(users, toId)} へ`;
  return (
    <span className={styles.fromTo} data-testid={testId} role="group" aria-label={label}>
      <Party id={fromId} users={users} compact={compact} />
      <Arrow />
      <Party id={toId} users={users} compact={compact} />
    </span>
  );
}
