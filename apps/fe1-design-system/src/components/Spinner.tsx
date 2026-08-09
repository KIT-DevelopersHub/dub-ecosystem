import type { SpinnerProps } from "../types";
import styles from "./Spinner.module.css";
import { cx } from "../utils/cx";

export function Spinner({ size = "md", testId, ...rest }: SpinnerProps) {
  const label = rest["aria-label"] ?? "読み込み中";
  return (
    <span
      className={cx(styles.spinner)}
      data-size={size}
      data-testid={testId}
      role="status"
      aria-label={label}
    />
  );
}
