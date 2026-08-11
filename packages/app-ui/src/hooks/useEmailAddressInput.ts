// Behavior for a multi-recipient email input, shared via a custom hook (layer ②
// composition rule: reuse behavior with hooks, not inheritance). The email string
// stays the source of truth (`"Name <a@b>, c@d"`); parsing/formatting are injected
// so this stays free of any mail domain library.
import { useState } from "react";

export interface EmailToken {
  email: string;
  name?: string;
}

export interface EmailParseResult {
  recipients: EmailToken[];
  invalid: string[];
}

export interface UseEmailAddressInputArgs {
  /** Raw address string (comma/semicolon separated). Source of truth. */
  value: string;
  onChange: (raw: string) => void;
  /** Domain parser (e.g. FE2 mail `parseRecipients`). Keeps this hook domain-free. */
  parse: (raw: string) => EmailParseResult;
  /** Serialize a token back into the raw string. Defaults to `Name <email>` / `email`. */
  format?: (token: EmailToken) => string;
}

export interface EmailAddressInput {
  draft: string;
  setDraft: (v: string) => void;
  recipients: EmailToken[];
  invalid: string[];
  /** Commit the current draft as a chip (strips a trailing separator). */
  commit: () => void;
  /** Remove a selected recipient by email. */
  remove: (email: string) => void;
  /** Add a candidate/suggestion directly (bypassing the draft). */
  add: (token: EmailToken) => void;
}

export const defaultFormatToken = (t: EmailToken): string =>
  t.name && t.name.length > 0 ? `${t.name} <${t.email}>` : t.email;

export function useEmailAddressInput({
  value,
  onChange,
  parse,
  format = defaultFormatToken,
}: UseEmailAddressInputArgs): EmailAddressInput {
  const [draft, setDraft] = useState("");
  const { recipients, invalid } = parse(value);

  const append = (text: string): void => {
    onChange(value ? `${value}, ${text}` : text);
  };

  const commit = (): void => {
    const t = draft.trim().replace(/[,;]$/, "");
    if (t.length > 0) append(t);
    setDraft("");
  };

  const remove = (email: string): void => {
    onChange(recipients.filter((r) => r.email !== email).map(format).join(", "));
  };

  const add = (token: EmailToken): void => {
    append(format(token));
    setDraft("");
  };

  return { draft, setDraft, recipients, invalid, commit, remove, add };
}
