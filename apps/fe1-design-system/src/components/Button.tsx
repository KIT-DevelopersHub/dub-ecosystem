import { useEffect, useRef, useState } from "react";
import type { ButtonProps, IconButtonProps } from "../types";
import styles from "./Button.module.css";
import { cx } from "../utils/cx";
import { Spinner } from "./Spinner";
import { Icon } from "./Icon";

// P12: how long the success checkmark/flash stays up before the button reverts
// to its normal look. Kept in sync with the CSS `--dub-motion-*` scale (this
// is longer than `--dub-motion-slow` (320ms) by design — success needs to be
// readable, not just perceptible).
const SUCCESS_FLASH_MS = 600;

/**
 * Primary action button. `loading` shows a spinner and suppresses onClick
 * (test matrix: loading 中は onClick 不発火). `success` (opt-in, P12) plays a
 * one-shot checkmark + flash on its rising edge — see ButtonProps.success.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  success = false,
  iconLeft,
  iconRight,
  type = "button",
  onClick,
  className,
  testId,
  children,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const [showSuccess, setShowSuccess] = useState(false);
  const wasSuccess = useRef(false);

  useEffect(() => {
    if (success && !wasSuccess.current) {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), SUCCESS_FLASH_MS);
      wasSuccess.current = success;
      return () => clearTimeout(timer);
    }
    wasSuccess.current = success;
    return undefined;
  }, [success]);

  const showSpinner = loading;
  const showCheck = !loading && showSuccess;

  return (
    <button
      type={type}
      className={cx(styles.button, className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-success={showCheck || undefined}
      data-testid={testId}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={() => {
        if (isDisabled) return;
        onClick?.();
      }}
    >
      {showSpinner && <Spinner size="sm" aria-label="読み込み中" />}
      {showCheck && <Icon name="check" size={size} className={styles.successIcon} />}
      {!showSpinner && !showCheck && iconLeft}
      <span className={cx(styles.label)}>{children}</span>
      {!showSpinner && !showCheck && iconRight}
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
