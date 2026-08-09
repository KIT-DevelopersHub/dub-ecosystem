import { useState } from "react";
import type { common } from "@dub/types";
import { Modal, Button, FormField } from "@dub/ui";
import { wrapUnknown } from "@dub/errors";
import { fieldErrorsOf } from "../lib/errorMap";
import { useActionRegistry } from "../context/ApiContext";
import { useCreateAction } from "../hooks/useEventMutations";
import styles from "./components.module.css";

export function ActionCreateModal({
  eventId,
  open,
  onClose,
  knownKinds = [],
}: {
  eventId: common.EventId;
  open: boolean;
  onClose: () => void;
  knownKinds?: readonly string[];
}) {
  const registry = useActionRegistry();
  const create = useCreateAction(eventId);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");

  // Suggestions: registered plugin types + kinds already present on this event.
  const suggestions = [...new Set([...registry.list().map((p) => p.type), ...knownKinds])];
  const fieldErrors = create.isError ? fieldErrorsOf(wrapUnknown(create.error)) : {};

  const submit = () => {
    create.mutate(
      { kind: kind.trim() || "generic", title },
      {
        onSuccess: () => {
          setTitle("");
          setKind("");
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="アクションを追加" testId="fe3-actionboard-create-modal">
      <FormField label="タイトル" error={fieldErrors.title} htmlFor="fe3-action-title">
        <input
          id="fe3-action-title"
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="fe3-actionboard-create-title"
        />
      </FormField>
      <FormField label="種別（既知の一覧から選択、または自由入力）" htmlFor="fe3-action-kind">
        <input
          id="fe3-action-kind"
          className={styles.input}
          list="fe3-action-kind-list"
          value={kind}
          placeholder="generic"
          onChange={(e) => setKind(e.target.value)}
          data-testid="fe3-actionboard-create-kind"
        />
        <datalist id="fe3-action-kind-list">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </FormField>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <Button variant="ghost" onClick={onClose}>
          キャンセル
        </Button>
        <Button variant="primary" onClick={submit} disabled={create.isPending} testId="fe3-actionboard-create-submit">
          追加
        </Button>
      </div>
    </Modal>
  );
}
