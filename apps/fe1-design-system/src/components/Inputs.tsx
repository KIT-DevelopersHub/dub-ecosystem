import { useLayoutEffect, useRef } from "react";
import type {
  CheckboxProps,
  DatePickerProps,
  RadioProps,
  SelectProps,
  SwitchProps,
  TextFieldProps,
  TextareaProps,
} from "../types";
import styles from "./Inputs.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  size = "md",
  invalid,
  disabled,
  type = "text",
  testId,
  ...rest
}: TextFieldProps) {
  return (
    <input
      id={id}
      className={cx(styles.input)}
      data-size={size}
      data-testid={testId}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={rest["aria-describedby"]}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Textarea({
  id,
  value,
  onChange,
  placeholder,
  rows = 4,
  invalid,
  disabled,
  autoGrow,
  singleLine,
  testId,
  ...rest
}: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!autoGrow || !el) return;
    const fit = () => {
      el.style.height = "auto";
      // border-box: scrollHeight は枠線を含まないので足す。
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    // 幅が変わると折り返し位置も変わるので測り直す。
    if (typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoGrow, value]);
  return (
    <textarea
      ref={ref}
      id={id}
      className={cx(styles.input, styles.textarea)}
      data-testid={testId}
      data-autogrow={autoGrow || undefined}
      rows={rows}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={rest["aria-describedby"]}
      onKeyDown={
        singleLine
          ? (e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) e.preventDefault();
            }
          : undefined
      }
      onChange={(e) => onChange(singleLine ? e.target.value.replace(/\r?\n/g, " ") : e.target.value)}
    />
  );
}

export function Select<V extends string = string>({
  id,
  value,
  onChange,
  options,
  placeholder,
  invalid,
  disabled,
  testId,
  ...rest
}: SelectProps<V>) {
  return (
    <select
      id={id}
      className={cx(styles.input, styles.select)}
      data-testid={testId}
      value={value ?? ""}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={rest["aria-describedby"]}
      onChange={(e) => onChange(e.target.value as V)}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} disabled={opt.disabled}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ id, checked, onChange, label, disabled, testId }: CheckboxProps) {
  return (
    <label className={cx(styles.control)} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Radio({ id, name, value, checked, onChange, label, disabled, testId }: RadioProps) {
  return (
    <label className={cx(styles.control)} htmlFor={id}>
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Switch({ id, checked, onChange, label, disabled, testId }: SwitchProps) {
  return (
    <label className={cx(styles.control, styles.switch)} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={cx(styles.switchTrack)} aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

/** v1 native date input wrapper (凍結案 1-6-4). */
export function DatePicker({
  id,
  value,
  onChange,
  min,
  max,
  invalid,
  disabled,
  testId,
}: DatePickerProps) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className={cx(styles.dateWrap)}>
      <input
        id={id}
        ref={ref}
        type="date"
        className={cx(styles.input)}
        data-testid={testId}
        value={value ?? ""}
        min={min}
        max={max}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
      <span className={cx(styles.dateIcon)} aria-hidden="true">
        <Icon name="calendar" size="sm" />
      </span>
    </span>
  );
}
