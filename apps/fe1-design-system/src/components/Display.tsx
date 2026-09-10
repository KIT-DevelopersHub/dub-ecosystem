import type { AvatarProps, BadgeProps, TagProps } from "../types";
import styles from "./Display.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";

export function Badge({ tone = "neutral", testId, children }: BadgeProps) {
  return (
    <span className={cx(styles.badge)} data-tone={tone} data-testid={testId}>
      {children}
    </span>
  );
}

export function Tag({ tone = "neutral", onRemove, testId, children }: TagProps) {
  return (
    <span className={cx(styles.tag)} data-tone={tone} data-testid={testId}>
      <span className={cx(styles.tagLabel)}>{children}</span>
      {onRemove && (
        <button
          type="button"
          className={cx(styles.tagRemove)}
          aria-label="削除"
          onClick={onRemove}
        >
          <Icon name="x" size="sm" />
        </button>
      )}
    </span>
  );
}

function initials(name: string): string {
  // Fail-safe: a shared leaf primitive must never throw on a null/undefined name
  // (would take the whole host app down via its error boundary). Coerce to "".
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

export function Avatar({ name, src, size = "md", testId }: AvatarProps) {
  return (
    <span className={cx(styles.avatar)} data-size={size} data-testid={testId} title={name}>
      {src ? (
        <img className={cx(styles.avatarImg)} src={src} alt={name} />
      ) : (
        <span className={cx(styles.avatarInitials)} aria-label={name}>
          {initials(name)}
        </span>
      )}
    </span>
  );
}
