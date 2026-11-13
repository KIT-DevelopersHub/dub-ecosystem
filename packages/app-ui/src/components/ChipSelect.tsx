// ChipSelect — layer ② composite. A Google-Calendar-style "add guests" field: type to filter the
// options, Enter / click adds one as a chip, × or Backspace (on an empty draft) removes. Unlike
// EmailAddressSelect it picks from a fixed option list (no free text), so it serves any
// multi-select of known things (roles, members, labels). Domain-free: the caller passes options
// with their label, sub text, icon and tone, and gets the chosen values back in order.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Skeleton, isImeComposing } from "@dub/ui";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import { normalizeSearchText } from "../hooks/useClientFilter";
import styles from "./ChipSelect.module.css";

export interface ChipSelectOption {
  value: string;
  label: string;
  /** Second line in the list (e.g. "ロール・3人"). */
  description?: string;
  /** Leading glyph for the chip and the option. */
  icon?: ReactNode;
  /** Chip colour: "brand" for groups (roles), "neutral" for single things (people). */
  tone?: "brand" | "neutral";
  /** Short kind word read out with the chip (e.g. "ロール" / "メンバー"). */
  kind?: string;
}

export interface ChipSelectProps {
  /** Chosen values, in the order they were added. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  options: readonly ChipSelectOption[];
  /** A chosen value that is not among the options (e.g. a deleted role). */
  fallbackOption?: (value: string) => ChipSelectOption;
  /** Options still loading: the list shows skeleton rows. */
  loading?: boolean;
  placeholder?: string;
  /** Max rows in the list. Default 8. */
  maxSuggestions?: number;
  id?: string;
  testId?: string;
  "aria-label"?: string;
  /** Marks the field invalid (FormField error). */
  invalid?: boolean;
}

export function ChipSelect({
  value,
  onChange,
  options,
  fallbackOption,
  loading = false,
  placeholder,
  maxSuggestions = 8,
  id,
  testId,
  "aria-label": ariaLabel,
  invalid = false,
}: ChipSelectProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const chosen = useMemo(
    () => value.map((v) => byValue.get(v) ?? fallbackOption?.(v) ?? { value: v, label: v }),
    [value, byValue, fallbackOption],
  );
  const suggestions = useMemo(() => {
    const taken = new Set(value);
    const q = normalizeSearchText(draft.trim());
    return options
      .filter((o) => !taken.has(o.value) && (!q || normalizeSearchText(`${o.label} ${o.description ?? ""}`).includes(q)))
      .slice(0, maxSuggestions);
  }, [options, value, draft, maxSuggestions]);

  const showList = focused && dismissedFor !== draft && (loading || suggestions.length > 0 || draft.trim().length > 0);
  const { activeIndex, setActiveIndex, move } = useListKeyboardNav({ count: showList ? suggestions.length : 0, resetKey: draft, defaultIndex: 0 });
  const autoId = useId();
  const listId = `${id ?? autoId}-listbox`;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const add = (o: ChipSelectOption) => {
    onChange([...value, o.value]);
    setDraft("");
    inputRef.current?.focus();
  };
  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  return (
    <div
      className={styles.field}
      data-invalid={invalid ? "true" : undefined}
      data-testid={testId ? `${testId}-field` : undefined}
      // A click on the empty part of the box focuses the input, as in Google Calendar.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {chosen.map((o) => (
        <span key={o.value} className={styles.chip} data-tone={o.tone ?? "neutral"} data-testid={testId ? `${testId}-chip` : undefined} data-value={o.value}>
          {o.icon ? <span className={styles.chipIcon}>{o.icon}</span> : null}
          <span className={styles.chipLabel}>{o.label}</span>
          {o.kind ? <span className={styles.srOnly}>（{o.kind}）</span> : null}
          <button type="button" aria-label={`${o.label} を外す`} className={styles.chipRemove} onClick={() => {
              remove(o.value);
              inputRef.current?.focus(); // the button goes away with the chip: keep typing / Backspace
            }}>
            ×
          </button>
        </span>
      ))}

      <input
        ref={inputRef}
        id={id}
        data-testid={testId}
        className={styles.input}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-activedescendant={showList && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(e) => {
          if (composingRef.current || isImeComposing(e)) return;
          if (e.key === "Backspace" && draft === "" && value.length > 0) {
            e.preventDefault();
            remove(value[value.length - 1]!);
            return;
          }
          if (!showList) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setDismissedFor(null);
              setFocused(true);
            }
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Escape") {
            // Close the list only, not the dialog around it.
            e.preventDefault();
            e.stopPropagation();
            setDismissedFor(draft);
          } else if (e.key === "Enter") {
            // Enter never submits the form from here: it adds the highlighted option, or nothing.
            e.preventDefault();
            const active = activeIndex >= 0 ? suggestions[activeIndex] : undefined;
            if (active) add(active);
          } else if (e.key === "Tab" && draft.trim() && activeIndex >= 0 && suggestions[activeIndex]) {
            e.preventDefault();
            add(suggestions[activeIndex]!);
          }
        }}
      />

      {showList ? (
        <ul ref={listRef} className={styles.listbox} id={listId} role="listbox" aria-busy={loading || undefined}>
          {loading ? (
            [0, 1, 2].map((i) => (
              <li key={i} className={styles.skeletonRow} role="presentation" data-testid={testId ? `${testId}-skeleton` : undefined}>
                <Skeleton variant="circle" width={20} />
                <Skeleton width="60%" />
              </li>
            ))
          ) : suggestions.length === 0 ? (
            <li className={styles.empty} role="presentation">
              該当する候補がありません
            </li>
          ) : (
            suggestions.map((o, i) => (
              <li key={o.value} role="presentation">
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  data-index={i}
                  aria-selected={i === activeIndex}
                  data-active={i === activeIndex ? "true" : undefined}
                  data-testid={testId ? `${testId}-option` : undefined}
                  className={styles.option}
                  onMouseEnter={() => setActiveIndex(i)}
                  // onMouseDown (not onClick) so it wins over the input's blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(o);
                  }}
                >
                  {o.icon ? <span className={styles.optionIcon} data-tone={o.tone ?? "neutral"}>{o.icon}</span> : null}
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>{o.label}</span>
                    {o.description ? <span className={styles.optionDescription}>{o.description}</span> : null}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
