// EmailAddressSelect — layer ② composite. A chip-based email recipient input with
// optional candidate autocomplete, composed from a headless behavior hook
// (useEmailAddressInput) + token-driven CSS. Domain-free: the caller injects the
// address `parse` fn and any `candidates` (e.g. from the roster / Email Routing),
// so the same component serves FE2 mail compose and FE7 roster address fields.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { isImeComposing } from "@dub/ui";
import {
  useEmailAddressInput,
  defaultFormatToken,
  type EmailToken,
  type EmailParseResult,
} from "../hooks/useEmailAddressInput";
import styles from "./EmailAddressSelect.module.css";

export interface EmailAddressSelectProps {
  /** Raw address string (source of truth). */
  value: string;
  onChange: (raw: string) => void;
  /** Domain address parser (keeps this component mail-library agnostic). */
  parse: (raw: string) => EmailParseResult;
  format?: (token: EmailToken) => string;
  /** Optional suggestions (e.g. roster members). Already-selected ones are hidden. */
  candidates?: EmailToken[];
  /** Leading label (e.g. "To"). Rendered inline, not a `<label>`. */
  label?: ReactNode;
  placeholder?: string;
  id?: string;
  testId?: string;
  /** Trailing slot after the input (e.g. Cc/Bcc toggles). */
  extra?: ReactNode;
  /** Custom remove-chip glyph (defaults to "×"). Lets consumers pass their icon. */
  removeIcon?: ReactNode;
  /** "boxed" (form field) | "flush" (borderless divider row). Default "boxed". */
  variant?: "boxed" | "flush";
}

const matches = (t: EmailToken, q: string): boolean => {
  const s = q.toLowerCase();
  return t.email.toLowerCase().includes(s) || (t.name ?? "").toLowerCase().includes(s);
};

export function EmailAddressSelect({
  value,
  onChange,
  parse,
  format = defaultFormatToken,
  candidates,
  label,
  placeholder,
  id,
  testId,
  extra,
  removeIcon,
  variant = "boxed",
}: EmailAddressSelectProps): JSX.Element {
  const { draft, setDraft, recipients, invalid, commit, remove, add } = useEmailAddressInput({
    value,
    onChange,
    parse,
    format,
  });
  const [focused, setFocused] = useState(false);
  // Don't commit a chip on the 変換確定 Enter/"," while an IME is composing.
  const composingRef = useRef(false);

  const invalidSet = useMemo(() => new Set(invalid.map((t) => t.trim())), [invalid]);
  const selected = useMemo(() => new Set(recipients.map((r) => r.email)), [recipients]);
  const suggestions = useMemo(() => {
    if (!candidates || draft.trim().length === 0) return [];
    const q = draft.trim();
    return candidates.filter((c) => !selected.has(c.email) && matches(c, q)).slice(0, 6);
  }, [candidates, draft, selected]);
  const showList = focused && suggestions.length > 0;
  const listId = id ? `${id}-listbox` : undefined;

  return (
    <div className={styles.field} data-variant={variant} data-testid={testId ? `${testId}-field` : undefined}>
      {label != null ? <span className={styles.label}>{label}</span> : null}

      {recipients.map((r) => (
        <span key={r.email} className={styles.chip}>
          {r.name ?? r.email}
          <button
            type="button"
            aria-label={`${r.email} を削除`}
            className={styles.chipRemove}
            onClick={() => remove(r.email)}
          >
            {removeIcon ?? "×"}
          </button>
        </span>
      ))}
      {[...invalidSet].map((raw) => (
        <span key={raw} className={styles.chip} data-invalid="true">
          {raw}
          <button
            type="button"
            aria-label={`${raw} を削除`}
            className={styles.chipRemove}
            onClick={() => onChange(value.split(/[,;\n]/).map((s) => s.trim()).filter((s) => s !== raw).join(", "))}
          >
            {removeIcon ?? "×"}
          </button>
        </span>
      ))}

      <input
        id={id}
        data-testid={testId}
        className={styles.input}
        value={draft}
        placeholder={placeholder}
        role={candidates ? "combobox" : undefined}
        aria-expanded={candidates ? showList : undefined}
        aria-controls={showList ? listId : undefined}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          // Delay so an option's onMouseDown/click can win before commit clears draft.
          window.setTimeout(() => setFocused(false), 120);
          commit();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(e) => {
          if (composingRef.current || isImeComposing(e)) return;
          if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            commit();
          }
        }}
      />

      {extra}

      {showList ? (
        <ul className={styles.listbox} id={listId} role="listbox">
          {suggestions.map((c) => (
            <li key={c.email}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className={styles.option}
                // onMouseDown (not onClick) so it fires before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(c);
                }}
              >
                {c.name ? <span className={styles.optionName}>{c.name}</span> : null}
                <span className={styles.optionEmail}>{c.email}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
