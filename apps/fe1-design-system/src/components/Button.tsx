import type { ButtonProps, IconButtonProps } from "../types";
import styles from "./Button.module.css";
import { cx } from "../utils/cx";
import { Spinner } from "./Spinner";
import { Icon } from "./Icon";

/**
 * Primary action button. `loading` shows a spinner and suppresses onClick
 * (test matrix: loading 中は onClick 不発火).
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  iconLeft,
  iconRight,
  type = "button",
  onClick,
  className,
  testId,
  children,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-testid={testId}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={() => {
        if (isDisabled) return;
        onClick?.();
      }}
    >
      {loading && <Spinner size="sm" aria-label="読み込み中" />}
      {!loading && iconLeft}
      <span className={cx(styles.label)}>{children}</span>
      {!loading && iconRight}
    </button>
  );
}

/** Icon-only button. `aria-label` is required by the type. */
export function IconButton({
  name,
  variant = "ghost",
  size = "md",
  loading = false,
  disabled = false,
  type = "button",
  onClick,
  testId,
  ...rest
}: IconButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      className={cx(styles.button, styles.iconButton)}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-testid={testId}
      disabled={isDisabled}
      aria-label={rest["aria-label"]}
      aria-busy={loading || undefined}
      onClick={() => {
        if (isDisabled) return;
        onClick?.();
      }}
    >
      {loading ? <Spinner size="sm" /> : <Icon name={name} size={size} />}
    </button>
  );
}
