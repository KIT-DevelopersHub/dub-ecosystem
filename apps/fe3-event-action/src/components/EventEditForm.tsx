import { useState } from "react";
import type { event } from "@dub/types";
import { Button, FormField } from "@dub/ui";
import { DraftRestoredNotice, useDraftAutosave, peekDraft } from "@dub/app-ui";
import { fieldErrorsOf, normalizeError } from "../lib/errorMap";
import { useUpdateEvent } from "../hooks/useEventMutations";
import styles from "./components.module.css";

interface EventEditDraft {
  title: string;
  description: string;
}

export function EventEditForm({
  event: ev,
  canWrite,
}: {
  event: event.DubEvent;
  canWrite: boolean;
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

  const readOnly = !canWrite || ev.archivedAt !== null;
  const fieldErrors = update.isError ? fieldErrorsOf(normalizeError(update.error)) : {};

  const dirty = title !== ev.title || description !== (ev.description ?? "");
  const draft = useDraftAutosave<EventEditDraft>({
    storageKey: draftKey,
    value: { title, description },
    dirty,
    enabled: !readOnly,
  });

  const save = () => {
    const req: event.UpdateEventRequest = { version: ev.version };
    if (title !== ev.title) req.title = title;
    if (description !== (ev.description ?? "")) req.description = description === "" ? null : description;
    update.mutate(req, { onSuccess: () => draft.clear() });
  };

  return (
    <div data-testid="fe3-settings-edit-form">
      <DraftRestoredNotice
        visible={draft.restoredVisible}
        onDiscard={() => {
          draft.clear();
          setTitle(ev.title);
          setDescription(ev.description ?? "");
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
      <FormField label="説明" htmlFor="fe3-edit-desc">
        <input
          id="fe3-edit-desc"
          className={styles.input}
          value={description}
          disabled={readOnly}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      {ev.archivedAt !== null ? (
        <div className={styles.errorText}>このイベントはアーカイブ済みのため編集できません。</div>
      ) : null}
      <Button variant="primary" onClick={save} disabled={readOnly || update.isPending} testId="fe3-settings-save">
        保存
      </Button>
    </div>
  );
}
