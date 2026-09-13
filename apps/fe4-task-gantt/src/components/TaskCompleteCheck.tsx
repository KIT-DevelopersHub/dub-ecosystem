import { useEffect, useRef, useState } from "react";
import styles from "../styles/app.module.css";

export interface TaskCompleteCheckProps {
  checked: boolean;
  disabled?: boolean;
  onCheck: () => void;
  label: string; // aria-label (e.g. "「<title>」を完了にする")
  testId?: string;
}

/**
 * P11 delight UX — quick-complete checkbox for the My Tasks list. A one-way
 * "mark as done" affordance (unchecking is still done via the status Select in
 * the detail dialog, which owns the full transition matrix). On the
 * false→true edge it draws the checkmark (SVG stroke-dashoffset) and holds a
 * brief pop, which `MyTaskList` pairs with a green row flash-then-fade —
 * together giving the completion action a moment of "done!" feedback and
 * making a stray/misplaced tap on the box hard to miss.
 */
export function TaskCompleteCheck({ checked, disabled, onCheck, label, testId }: TaskCompleteCheckProps) {
  const [justChecked, setJustChecked] = useState(false);
  const wasChecked = useRef(checked);

  useEffect(() => {
    if (checked && !wasChecked.current) {
      setJustChecked(true);
      const timer = setTimeout(() => setJustChecked(false), 220);
      wasChecked.current = checked;
      return () => clearTimeout(timer);
    }
    wasChecked.current = checked;
    return undefined;
  }, [checked]);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled || checked}
      className={`${styles.completeCheck} ${checked ? styles.completeCheckOn : ""} ${justChecked ? styles.completeCheckFlash : ""}`}
      onClick={(e) => {
        // The row itself opens the detail dialog on click — the checkbox is a
        // separate, narrower hit target that must not also trigger that.
        e.stopPropagation();
        if (!disabled && !checked) onCheck();
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
        <rect x="1" y="1" width="14" height="14" rx="4" className={styles.completeCheckBox} />
        <path d="M4 8.4 L6.8 11.2 L12 5.4" className={styles.completeCheckMark} />
      </svg>
    </button>
  );
}
