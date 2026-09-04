// "○○さんが入力中…" strip shown just above the composer. Subscribes to the typing
// store (fed by the realtime channel in production, by the demo simulator otherwise)
// and renders an animated three-dot bubble plus the typing member name(s). Renders
// nothing when no one is typing so it takes no layout when idle.
import type { common, identity } from "@dub/types";
import { Avatar } from "@dub/ui";
import { useTypingUsers } from "../hooks/useChatLive";
import styles from "../styles/chat.module.css";

export interface TypingIndicatorProps {
  channelId: common.ChannelId;
  currentUserId: common.UserId;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
}

function label(names: string[]): string {
  if (names.length === 1) return `${names[0]} さんが入力中`;
  if (names.length === 2) return `${names[0]} さんと ${names[1]} さんが入力中`;
  return `${names[0]} さん 他 ${names.length - 1} 人が入力中`;
}

export function TypingIndicator({ channelId, currentUserId, resolveUser }: TypingIndicatorProps) {
  const typing = useTypingUsers(channelId).filter((id) => id !== currentUserId);
  if (typing.length === 0) return null;

  const names = typing.map((id) => resolveUser?.(id)?.displayName ?? id);

  return (
    <div className={styles.typingIndicator} role="status" aria-live="polite" data-testid="fe6-typing-indicator">
      <span className={styles.typingAvatars} aria-hidden>
        {typing.slice(0, 3).map((id) => (
          <Avatar key={id} name={resolveUser?.(id)?.displayName ?? id} src={resolveUser?.(id)?.avatarUrl ?? undefined} size="sm" />
        ))}
      </span>
      <span className={styles.typingDots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className={styles.typingText}>{label(names)}</span>
    </div>
  );
}
