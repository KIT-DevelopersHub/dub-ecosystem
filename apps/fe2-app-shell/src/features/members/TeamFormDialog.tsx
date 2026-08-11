// Create / edit dialog for a チーム (班).
import { useEffect, useState } from "react";
import { Modal, Button, Form, FormField, TextField, Textarea } from "@dub/ui";
import type { MemberTeam } from "./contracts.ts";
import { useCreateTeam, useUpdateTeam } from "./hooks.ts";
import styles from "./members.module.css";

export function TeamFormDialog({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: MemberTeam | null;
}): JSX.Element {
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setColor(editing?.color ?? "");
  }, [open, editing]);

  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (name.trim().length === 0) {
      setError("チーム名を入力してください");
      return;
    }
    const payload = { name: name.trim(), description: description.trim() || null, color: color.trim() || null };
    const done = () => onClose();
    if (editing) {
      update.mutate({ id: editing.id, patch: payload }, { onSuccess: done });
    } else {
      create.mutate(payload, { onSuccess: done });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "チームを編集" : "チームを追加"}
      size="sm"
      testId="members-team-dialog"
      footer={
        <div className={styles.dialogFooter}>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} testId="members-team-submit">
            {editing ? "保存" : "追加"}
          </Button>
        </div>
      }
    >
      <Form onSubmit={submit}>
        <div className={styles.formStack}>
          <FormField label="チーム名" htmlFor="team-name" required {...(error ? { error } : {})}>
            <TextField id="team-name" value={name} onChange={setName} testId="members-team-name" />
          </FormField>
          <FormField label="カラー" htmlFor="team-color" help="任意 (例: #4f46e5) — 他アプリのチーム表示でも使われます">
            <TextField id="team-color" value={color} onChange={setColor} placeholder="#4f46e5" />
          </FormField>
          <FormField label="説明" htmlFor="team-desc">
            <Textarea id="team-desc" value={description} onChange={setDescription} rows={2} />
          </FormField>
        </div>
      </Form>
    </Modal>
  );
}
