// SearchInput — the shared search box (凍結案: one control for "type to filter").
// Leading magnifier icon, a clear (×) button that appears once there's text, an
// accessible label, and optional debounced onChange. Controlled by `value`; the
// internal `draft` gives instant keystroke feedback while `onChange` is debounced.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SearchInputProps } from "../types";
import styles from "./SearchInput.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";

export function SearchInput({
  value,
  onChange,
  placeholder = "検索",
  size = "md",
  disabled,
  debounceMs = 0,
  testId,
  id,
  ...rest
}: SearchInputProps) {
  const ariaLabel = rest["aria-label"] ?? "検索";
  const autoId = useId();
  const inputId = id ?? autoId;
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Keep the draft in sync when the committed value changes from outside (e.g. reset).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const commit = useCallback(
    (next: string, immediate: boolean) => {
      setDraft(next);
      clearTimer();
      if (immediate || debounceMs <= 0) {
        onChangeRef.current(next);
      } else {
        timer.current = setTimeout(() => onChangeRef.current(next), debounceMs);
      }
    },
    [debounceMs],
  );

  const clear = useCallback(() => commit("", true), [commit]);

  return (
    <div className={cx(styles.root)} data-size={size} role="search" data-testid={testId}>
      <Icon name="search" size="sm" className={styles.leadingIcon} aria-hidden="true" />
      <input
        id={inputId}
        className={cx(styles.input)}
        data-size={size}
        data-testid={testId ? `${testId}-input` : undefined}
        type="search"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => commit(e.target.value, false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && draft !== "") {
            e.preventDefault();
            clear();
          }
        }}
      />
      {draft !== "" ? (
        <button
          type="button"
          className={cx(styles.clear)}
          onClick={clear}
          disabled={disabled}
          aria-label="検索をクリア"
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <Icon name="x" size="sm" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export default SearchInput;
