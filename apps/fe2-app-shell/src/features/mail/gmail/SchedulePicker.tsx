// 予約送信 (scheduled send) picker: the clock button + a popover with a datetime-local
// input. Shared by the floating compose (ComposeWindow) and the inline reply (ReadingPane)
// so both surfaces schedule with the same UI and the same "must be in the future" rule.
// The caller owns the payload: `onSchedule(when)` builds/sends the request and returns an
// error message to show (popover stays open) or null (popover closes).
import { useState } from "react";
import { Button } from "@dub/ui";
import { MailIcon } from "./icons.tsx";
import styles from "./SchedulePicker.module.css";

/** Format a Date as a `datetime-local` value (YYYY-MM-DDTHH:mm) in LOCAL time — the picker
 *  shows and returns local wall-clock; we convert to an absolute instant on confirm. */
export function toDatetimeLocal(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Validate a picked local datetime. Returns the instant, or an error message. */
export function parseScheduleTime(value: string, now: number = Date.now()): Date | string {
  if (!value) return "送信日時を選んでください";
  const when = new Date(value);
  if (Number.isNaN(when.getTime()) || when.getTime() <= now) return "未来の日時を選んでください";
  return when;
}

export interface SchedulePickerProps {
  /** testid prefix: `<prefix>-open|popover|input|confirm` (e.g. "fe2-mail-compose-schedule"). */
  testIdPrefix: string;
  onSchedule: (when: Date) => string | null | Promise<string | null>;
  disabled?: boolean;
  disabledReason?: string;
  /** Extra line under the input (e.g. how many files ride along). */
  hint?: string;
}

export function SchedulePicker({ testIdPrefix, onSchedule, disabled, disabledReason, hint }: SchedulePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const confirm = async (): Promise<void> => {
    const when = parseScheduleTime(value);
    if (typeof when === "string") {
      setErr(when);
      return;
    }
    setPending(true);
    try {
      const failure = await onSchedule(when);
      if (failure) setErr(failure);
      else setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.anchor}>
      <button
        type="button"
        className={styles.trigger}
        aria-label="送信日時を設定"
        aria-expanded={open}
        data-testid={`${testIdPrefix}-open`}
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : "送信日時を設定 (予約送信)"}
        onClick={() => {
          setErr(null);
          if (!value) setValue(toDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000)));
          setOpen((v) => !v);
        }}
      >
        <MailIcon name="clock" size={18} />
      </button>
      {open ? (
        <div className={styles.popover} data-testid={`${testIdPrefix}-popover`}>
          <span className={styles.title}>送信日時を設定</span>
          <input
            type="datetime-local"
            className={styles.input}
            aria-label="送信日時"
            data-testid={`${testIdPrefix}-input`}
            value={value}
            min={toDatetimeLocal(new Date(Date.now() + 60 * 1000))}
            onChange={(e) => {
              setValue(e.target.value);
              setErr(null);
            }}
          />
          {hint ? <span className={styles.hint}>{hint}</span> : null}
          {err ? (
            <span className={styles.error} role="alert">
              {err}
            </span>
          ) : null}
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button size="sm" loading={pending} onClick={() => void confirm()} testId={`${testIdPrefix}-confirm`}>
              予約する
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
