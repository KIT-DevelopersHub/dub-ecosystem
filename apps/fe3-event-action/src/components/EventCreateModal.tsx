import { useState } from "react";
import type { event } from "@dub/types";
import { Modal, Button, FormField } from "@dub/ui";
import { fieldErrorsOf, normalizeError } from "../lib/errorMap";
import { useCreateEvent } from "../hooks/useEventMutations";
import styles from "./components.module.css";

export function EventCreateModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (ev: event.DubEvent) => void;
}) {
  const create = useCreateEvent();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const fieldErrors = create.isError ? fieldErrorsOf(normalizeError(create.error)) : {};

  const submit = () => {
    const req: event.CreateEventRequest = { title };
    if (description.trim()) req.description = description;
    create.mutate(req, {
      onSuccess: (ev) => {
        setTitle("");
        setDescription("");
        onCreated?.(ev);
        onClose();
      },
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="イベントを作成" testId="fe3-eventlist-create-modal">
      <FormField label="タイトル" error={fieldErrors.title} htmlFor="fe3-create-title">
        <input
          id="fe3-create-title"
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="fe3-eventlist-create-title"
        />
      </FormField>
      <FormField label="説明（任意）" htmlFor="fe3-create-desc">
        <input
          id="fe3-create-desc"
          className={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <Button variant="ghost" onClick={onClose}>
          キャンセル
        </Button>
        <Button variant="primary" onClick={submit} disabled={create.isPending} testId="fe3-eventlist-create-submit">
          作成
        </Button>
      </div>
    </Modal>
  );
}
