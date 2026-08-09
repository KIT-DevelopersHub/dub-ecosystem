import { useState } from "react";
import type { event } from "@dub/types";
import { Button, FormField } from "@dub/ui";
import { wrapUnknown } from "@dub/errors";
import { fieldErrorsOf } from "../lib/errorMap";
import { useUpdateEvent } from "../hooks/useEventMutations";
import styles from "./components.module.css";

export function EventEditForm({
  event: ev,
  canWrite,
}: {
  event: event.DubEvent;
  canWrite: boolean;
}) {
  const update = useUpdateEvent(ev.id);
  const [title, setTitle] = useState(ev.title);
  const [description, setDescription] = useState(ev.description ?? "");

  const readOnly = !canWrite || ev.archivedAt !== null;
  const fieldErrors = update.isError ? fieldErrorsOf(wrapUnknown(update.error)) : {};

  const save = () => {
    const req: event.UpdateEventRequest = { version: ev.version };
    if (title !== ev.title) req.title = title;
    if (description !== (ev.description ?? "")) req.description = description === "" ? null : description;
    update.mutate(req);
  };

  return (
    <div data-testid="fe3-settings-edit-form">
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
