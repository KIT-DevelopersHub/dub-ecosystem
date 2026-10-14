/// <reference lib="dom" />
// Small name dialog for creating / renaming a personal sidebar section.
import { useEffect, useState } from "react";
import { Button, FormField, Modal, TextField } from "@dub/ui";
import styles from "../styles/chat.module.css";

export const SECTION_NAME_MAX = 40;

export interface SectionNameModalProps {
  open: boolean;
  title: string;
  submitLabel: string;
  initialName?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function SectionNameModal({ open, title, submitLabel, initialName = "", onSubmit, onClose }: SectionNameModalProps) {
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    // TextField has no autoFocus prop; focus after the modal mounts.
    const h = globalThis.setTimeout(() => globalThis.document?.getElementById("fe6-section-name")?.focus(), 0);
    return () => globalThis.clearTimeout(h);
  }, [open, initialName]);

  const trimmed = name.trim();
  const tooLong = trimmed.length > SECTION_NAME_MAX;
  const valid = trimmed.length > 0 && !tooLong;

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title={title} size="sm" testId="fe6-section-name-modal">
      <form
        className={styles.createForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSubmit(trimmed); // optimistic: the caller applies it locally right away
          onClose();
        }}
      >
        <FormField
          label="セクション名"
          htmlFor="fe6-section-name"
          {...(tooLong ? { error: `${SECTION_NAME_MAX}文字以内で入力してください` } : { help: "例: 運営、よく見る、プロジェクト" })}
        >
          <TextField id="fe6-section-name" value={name} onChange={setName} invalid={tooLong} testId="fe6-section-name-input" />
        </FormField>
        <div className={styles.createActions}>
          <Button variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={!valid} testId="fe6-section-name-submit">
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
