import { useState } from "react";
import type { event } from "@dub/types";
import { Button, FormField } from "@dub/ui";
import { DraftRestoredNotice, useDraftAutosave, peekDraft } from "@dub/app-ui";
import { fieldErrorsOf, normalizeError } from "../lib/errorMap";
import { useUpdateEvent } from "../hooks/useEventMutations";
import styles from "./components.module.css";

// ── date helpers ─────────────────────────────────────────────────────────────
// The wire carries ISODateTime (UTC instant, e.g. "2026-08-09T00:00:00Z"); the
// <input type="datetime-local"> control speaks local wall-clock "YYYY-MM-DDTHH:mm".
// Convert at the boundary so what the user picks round-trips back to the same instant.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v); // interpreted as local time
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
// Compare two ISO values as instants (null-safe), so unchanged fields are not sent.
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

interface EventEditDraft {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
}

export function EventEditForm({
  event: ev,
  canWrite,
  onCancel,
  onSaved,
}: {
  event: event.DubEvent;
  canWrite: boolean;
  /** Rendered as a "キャンセル" button next to 保存 when provided (inline-edit callers). */
  onCancel?: () => void;
  /** Fired once the edit is done — on successful save, and also when Save is
   *  pressed with no actual changes (nothing to round-trip). Lets an inline
   *  caller (e.g. the hub hero) close its own edit mode without navigating. */
  onSaved?: () => void;
}) {
  const update = useUpdateEvent(ev.id);
  // FE3 owns no router (navigation goes through @dub/app-ui's NavigationApi), so the
  // in-app leave guard used in FE2/FE7 (TanStack useBlocker) isn't available here.
  // useDraftAutosave still fully protects the work: the draft is auto-saved and
  // restored on return, and a beforeunload prompt covers reload / tab close.
  const draftKey = `fe3.event.${ev.id}`;
  const seed = peekDraft<EventEditDraft>(draftKey);
  const [title, setTitle] = useState(seed?.title ?? ev.title);
  const [description, setDescription] = useState(seed?.description ?? ev.description ?? "");
  const [startsAt, setStartsAt] = useState(seed?.startsAt ?? toLocalInput(ev.startsAt));
  const [endsAt, setEndsAt] = useState(seed?.endsAt ?? toLocalInput(ev.endsAt));
  const [localError, setLocalError] = useState<string | null>(null);

  const readOnly = !canWrite || ev.archivedAt !== null;
  const fieldErrors = update.isError ? fieldErrorsOf(normalizeError(update.error)) : {};

  const dirty =
    title !== ev.title ||
    description !== (ev.description ?? "") ||
    startsAt !== toLocalInput(ev.startsAt) ||
    endsAt !== toLocalInput(ev.endsAt);
  const draft = useDraftAutosave<EventEditDraft>({
    storageKey: draftKey,
    value: { title, description, startsAt, endsAt },
    dirty,
    enabled: !readOnly,
  });

  const save = () => {
    setLocalError(null);
    const startsIso = fromLocalInput(startsAt);
    const endsIso = fromLocalInput(endsAt);

    // Client-side guard: an end that precedes the start is never valid.
    if (startsIso !== null && endsIso !== null && new Date(endsIso).getTime() < new Date(startsIso).getTime()) {
      setLocalError("終了日時は開始日時より後にしてください。");
      return;
    }

    const req: event.UpdateEventRequest = { version: ev.version };
    if (title !== ev.title) req.title = title;
    if (description !== (ev.description ?? "")) req.description = description === "" ? null : description;
    if (!sameInstant(startsIso, ev.startsAt)) req.startsAt = startsIso;
    if (!sameInstant(endsIso, ev.endsAt)) req.endsAt = endsIso;

    // Nothing changed besides version — skip the round-trip.
    const changedKeys = Object.keys(req).filter((k) => k !== "version");
    if (changedKeys.length === 0) {
      draft.clear();
      onSaved?.();
      return;
    }

    update.mutate(req, {
      onSuccess: () => {
        draft.clear();
        onSaved?.();
      },
    });
  };

  return (
    <div data-testid="fe3-settings-edit-form">
      <DraftRestoredNotice
        visible={draft.restoredVisible}
        onDiscard={() => {
          draft.clear();
          setTitle(ev.title);
          setDescription(ev.description ?? "");
          setStartsAt(toLocalInput(ev.startsAt));
          setEndsAt(toLocalInput(ev.endsAt));
        }}
        onKeep={draft.acknowledgeRestored}
        testId="fe3-settings-draft-notice"
      />
      <FormField label="タイトル" error={fieldErrors.title} htmlFor="fe3-edit-title">
        <input
          id="fe3-edit-title"
          className={styles.input}
          value={title}
          disabled={readOnly}
          onChange={(e) => setTitle(e.target.value)}
        />
      </FormField>
      <FormField label="開始日時" error={fieldErrors.startsAt} htmlFor="fe3-edit-starts">
        <input
          id="fe3-edit-starts"
          type="datetime-local"
          data-testid="fe3-edit-starts"
          className={styles.input}
          value={startsAt}
          disabled={readOnly}
          onChange={(e) => setStartsAt(e.target.value)}
        />
      </FormField>
      <FormField label="終了日時" error={fieldErrors.endsAt} htmlFor="fe3-edit-ends">
        <input
          id="fe3-edit-ends"
          type="datetime-local"
          data-testid="fe3-edit-ends"
          className={styles.input}
          value={endsAt}
          disabled={readOnly}
          onChange={(e) => setEndsAt(e.target.value)}
        />
      </FormField>
      <FormField label="説明" htmlFor="fe3-edit-desc">
        <input
          id="fe3-edit-desc"
          className={styles.input}
          value={description}
          disabled={readOnly}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      {localError ? (
        <div className={styles.errorText} role="alert" data-testid="fe3-settings-edit-error">
          {localError}
        </div>
      ) : null}
      {ev.archivedAt !== null ? (
        <div className={styles.errorText}>このイベントはアーカイブ済みのため編集できません。</div>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" onClick={save} disabled={readOnly || update.isPending} testId="fe3-settings-save">
          保存
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={update.isPending} testId="fe3-settings-edit-cancel">
            キャンセル
          </Button>
        ) : null}
      </div>
    </div>
  );
}
