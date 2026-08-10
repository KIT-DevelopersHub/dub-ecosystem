import type { RateLimitNoticeProps } from "../types";
import styles from "./RateLimitNotice.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import { Badge } from "./Display";

/**
 * Human-readable Japanese recovery hint from an ISO8601 `recoversAt` estimate.
 * Pure (exported for unit tests): no `recoversAt` means the upstream quota is exhausted
 * with no ETA; a past/near instant reads as "まもなく"; otherwise round UP to the coarsest
 * useful unit so the copy never under-promises.
 */
export function formatRecoveryText(recoversAt: string | null | undefined, nowMs: number): string {
  if (!recoversAt) return "送信上限に達しました。回復までしばらくお待ちください。";
  const ms = Date.parse(recoversAt);
  if (Number.isNaN(ms)) return "回復までしばらくお待ちください。";
  const remainMs = ms - nowMs;
  if (remainMs <= 0) return "まもなく回復する見込みです。";
  const min = Math.ceil(remainMs / 60_000);
  if (min >= 60) return `約${Math.ceil(min / 60)}時間後に回復する見込みです。`;
  return `約${min}分後に回復する見込みです。`;
}

/**
 * Accessible "service is rate-limited" banner (FE1 §6 states family). Domain-agnostic:
 * the consumer passes `serviceLabel` (e.g. "メール送信API") and the backend-derived
 * `active` / `recoversAt`. Renders NOTHING when `active` is false, so a surface can mount
 * it unconditionally. Announced politely (role="status", aria-live) so a screen-reader
 * user hears it appear without stealing focus. `now` is injectable for deterministic tests.
 */
export function RateLimitNotice({
  serviceLabel,
  active,
  recoversAt,
  now,
  tone = "warning",
  testId,
}: RateLimitNoticeProps) {
  if (!active) return null;
  const recovery = formatRecoveryText(recoversAt, now ?? Date.now());
  return (
    <div className={cx(styles.notice)} data-tone={tone} role="status" aria-live="polite" data-testid={testId}>
      <span className={cx(styles.icon)}>
        <Icon name="warning" size="md" aria-label="制限中" />
      </span>
      <div className={cx(styles.body)}>
        <p className={cx(styles.title)}>
          <Badge tone={tone}>制限中</Badge>
          <span>{`${serviceLabel}が一時的に制限されています`}</span>
        </p>
        <p className={cx(styles.description)}>{recovery}</p>
      </div>
    </div>
  );
}
