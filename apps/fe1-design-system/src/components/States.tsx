import type { EmptyStateProps, ErrorStateProps, SkeletonLoaderProps } from "../types";
import styles from "./States.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import { Button } from "./Button";

export function EmptyState({ title, description, icon, action, testId }: EmptyStateProps) {
  return (
    <div className={cx(styles.center)} data-testid={testId}>
      {icon && (
        <span className={cx(styles.icon)}>
          <Icon name={icon} size="lg" />
        </span>
      )}
      <p className={cx(styles.title)}>{title}</p>
      {description && <p className={cx(styles.description)}>{description}</p>}
      {action && <div className={cx(styles.action)}>{action}</div>}
    </div>
  );
}

// Code-specific presentation (FE1 §6): FORBIDDEN=access note, NOT_FOUND=empty-ish,
// INTERNAL=correlationId + retry.
export function ErrorState({ error, onRetry, testId }: ErrorStateProps) {
  return (
    <div className={cx(styles.center)} role="alert" data-error-code={error.code} data-testid={testId}>
      <span className={cx(styles.icon, styles.errorIcon)}>
        <Icon name={error.code === "FORBIDDEN" ? "shield" : "alert-triangle"} size="lg" />
      </span>
      <p className={cx(styles.title)}>{error.message}</p>
      {error.correlationId && (
        <p className={cx(styles.correlation)}>ID: {error.correlationId}</p>
      )}
      {onRetry && (
        <div className={cx(styles.action)}>
          <Button variant="secondary" onClick={onRetry}>
            再試行
          </Button>
        </div>
      )}
    </div>
  );
}

export function SkeletonLoader({ lines = 3, width, testId }: SkeletonLoaderProps) {
  return (
    <div className={cx(styles.skeleton)} data-testid={testId} role="status" aria-label="読み込み中">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className={cx(styles.skeletonLine)}
          style={{ width: i === lines - 1 ? "60%" : (width ?? "100%") }}
        />
      ))}
    </div>
  );
}
