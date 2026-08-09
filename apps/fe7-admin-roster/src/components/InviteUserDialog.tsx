import { useState } from "react";
import type { identity } from "@dub/types";
import { Modal, TextField, Select, Button, uiStyles as s } from "../ui/primitives";
import { useInviteUser, useRoles } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { presentError, fieldErrorMap } from "../lib/errorDisplay";

export function InviteUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleId, setRoleId] = useState<string>("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const roles = useRoles();
  const invite = useInviteUser();
  const { toast } = useToast();

  function reset() {
    setEmail("");
    setDisplayName("");
    setRoleId("");
    setFieldErrors({});
    setFormError(null);
  }

  function submit() {
    setFieldErrors({});
    setFormError(null);
    const req: identity.InviteUserRequest = {
      email: email.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(roleId ? { roleIds: [roleId] } : {}),
    };
    invite.mutate(req, {
      onSuccess: () => {
        toast({ kind: "success", title: "招待を送信しました", description: email });
        reset();
        onClose();
      },
      onError: (err) => {
        const p = presentError(err);
        if (p.kind === "field-errors") setFieldErrors(fieldErrorMap(p.fields));
        else if ("message" in p) setFormError(p.message);
      },
    });
  }

  return (
    <Modal title="ユーザーを招待" open={open} onClose={onClose} testId="fe7-invite-dialog">
      <TextField
        label="メールアドレス"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors.email}
        testId="fe7-invite-email"
      />
      <TextField
        label="表示名（任意）"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        testId="fe7-invite-name"
      />
      <Select label="事前ロール（任意）" value={roleId} onChange={(e) => setRoleId(e.target.value)} testId="fe7-invite-role">
        <option value="">なし</option>
        {roles.data?.items.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </Select>
      {formError ? <p className={s.error} role="alert">{formError}</p> : null}
      <div className={s.modalActions}>
        <Button onClick={onClose} testId="fe7-invite-cancel">キャンセル</Button>
        <Button variant="primary" onClick={submit} disabled={invite.isPending} testId="fe7-invite-submit">
          招待する
        </Button>
      </div>
    </Modal>
  );
}
