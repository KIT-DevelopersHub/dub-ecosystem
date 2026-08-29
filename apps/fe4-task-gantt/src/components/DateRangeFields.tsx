import { DateField } from "./DateField";
import styles from "../styles/app.module.css";

export interface DateRangeFieldsProps {
  /** 開始日 value (yyyy-mm-dd) or null. */
  startValue: string | null;
  /** 終了日 value (yyyy-mm-dd) or null. */
  dueValue: string | null;
  onStartChange: (next: string | null) => void;
  onDueChange: (next: string | null) => void;
  disabled?: boolean;
  /**
   * Prefix for the two inputs' ids + their `htmlFor` labels:
   * `${idPrefix}-start` / `${idPrefix}-due`.
   */
  idPrefix: string;
  /**
   * Prefix for the two fields' testIds (defaults to `idPrefix`):
   * `${testIdPrefix}-start` / `${testIdPrefix}-due`. Kept separate because the
   * My Tasks 発行 modal addresses its fields as `fe4-mytask-create-*` while its
   * ids are `fe4-mytask-*`.
   */
  testIdPrefix?: string;
  startLabel?: string;
  dueLabel?: string;
}

/**
 * The single 開始日 ／ 終了日 pair used everywhere a task's planned window is
 * edited — the create modal (タスクを作成), the 発行 modal (タスクを発行) and the
 * right-docked detail panel. One component so the two dates are ALWAYS laid out
 * side by side (横並び) with the same spacing, labels and clear behaviour, and so
 * no surface can drift back to a lone 終了日 (判断37: 共通化＋開始日の欠落解消).
 *
 * The row spans the full width of its container (`grid-column: 1 / -1`) so that,
 * even when dropped inside the two-column `formGrid`, the pair gets the whole row
 * and the two calendars sit next to each other instead of being squeezed into a
 * half cell and wrapping.
 */
export function DateRangeFields({
  startValue,
  dueValue,
  onStartChange,
  onDueChange,
  disabled,
  idPrefix,
  testIdPrefix,
  startLabel = "開始日",
  dueLabel = "終了日",
}: DateRangeFieldsProps) {
  const tp = testIdPrefix ?? idPrefix;
  return (
    <div className={styles.dateRangeRow} data-testid={`${tp}-daterange`}>
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor={`${idPrefix}-start`}>
          {startLabel}
        </label>
        <DateField
          id={`${idPrefix}-start`}
          value={startValue}
          disabled={disabled}
          onChange={onStartChange}
          testId={`${tp}-start`}
        />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor={`${idPrefix}-due`}>
          {dueLabel}
        </label>
        <DateField
          id={`${idPrefix}-due`}
          value={dueValue}
          disabled={disabled}
          onChange={onDueChange}
          testId={`${tp}-due`}
        />
      </div>
    </div>
  );
}
