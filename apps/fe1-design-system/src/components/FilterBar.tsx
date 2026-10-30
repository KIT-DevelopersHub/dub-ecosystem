import type { FilterBarProps, FilterChipProps, FilterChipsProps } from "../types";
import { cx } from "../utils/cx";
import styles from "./FilterBar.module.css";

// Chip-style filter UI shared by every list/table (gantt, 人事, …):
//   <FilterBar activeCount onClear>  bordered bar: funnel + label + count badge + クリア
//     <FilterChips … />              pill chips (single or multiple selection)
//     <FilterChip … />               a lone toggle chip (e.g. アーカイブ含む)
// Look is fixed here so filters never drift between apps.

function FunnelIcon() {
  return (
    <svg className={styles.funnel} width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none">
      <path
        d="M2 3h12l-4.5 5.4V13l-3 1.5V8.4L2 3Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FilterBar({
  children,
  label = "フィルタ",
  activeCount = 0,
  activeCountTestId,
  onClear,
  clearLabel = "クリア",
  clearTestId,
  disabled,
  testId,
  className,
  ...rest
}: FilterBarProps) {
  return (
    <div className={cx(styles.bar, className)} role="group" aria-label={rest["aria-label"]} data-testid={testId}>
      <span className={styles.lead}>
        <FunnelIcon />
        <span className={styles.label}>{label}</span>
        {activeCount > 0 && (
          <span className={styles.badge} data-testid={activeCountTestId}>
            {activeCount}
          </span>
        )}
      </span>
      {children}
      {onClear && activeCount > 0 && (
        <button type="button" className={styles.clear} disabled={disabled} onClick={onClear} data-testid={clearTestId}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}

export function FilterChip({
  selected,
  onToggle,
  children,
  count,
  countTestId,
  disabled,
  role = "pressed",
  testId,
}: FilterChipProps) {
  const a11y = role === "radio" ? { role: "radio" as const, "aria-checked": selected } : { "aria-pressed": selected };
  return (
    <button
      type="button"
      {...a11y}
      className={styles.chip}
      data-selected={selected || undefined}
      disabled={disabled}
      onClick={onToggle}
      data-testid={testId}
    >
      {selected && (
        <span className={styles.check} aria-hidden>
          ✓
        </span>
      )}
      {children}
      {count != null && (
        <span className={styles.count} data-testid={countTestId}>
          {count}
        </span>
      )}
    </button>
  );
}

export function FilterChips<V extends string = string>(props: FilterChipsProps<V>) {
  const { options, disabled, testId } = props;
  const isOn = (v: V) => (props.multiple ? props.value.includes(v) : props.value === v);
  const toggle = (v: V) => {
    if (props.multiple) {
      props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    } else if (props.value !== v) {
      props.onChange(v);
    }
  };
  return (
    <span
      className={styles.group}
      role={props.multiple ? "group" : "radiogroup"}
      aria-label={props["aria-label"]}
      data-testid={testId}
    >
      {options.map((o) => (
        <FilterChip
          key={o.value}
          selected={isOn(o.value)}
          onToggle={() => toggle(o.value)}
          disabled={disabled || o.disabled}
          role={props.multiple ? "pressed" : "radio"}
          count={o.count}
          countTestId={o.countTestId}
          testId={o.testId}
        >
          {o.label}
        </FilterChip>
      ))}
    </span>
  );
}
