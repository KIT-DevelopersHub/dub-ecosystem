import { useState } from "react";
import type { identity } from "@dub/types";
import { Modal, TextField, Button, FormField } from "@dub/ui";
import { RolePicker, DialogActions, FormError } from "@dub/app-ui";
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
      <FormField label="メールアドレス" htmlFor="fe7-invite-email" error={fieldErrors.email}>
        <TextField
          id="fe7-invite-email"
          type="email"
          value={email}
          onChange={(v) => setEmail(v)}
          testId="fe7-invite-email"
        />
      </FormField>
      <FormField label="表示名（任意）" htmlFor="fe7-invite-name">
        <TextField id="fe7-invite-name" value={displayName} onChange={(v) => setDisplayName(v)} testId="fe7-invite-name" />
      </FormField>
      <RolePicker
        label="事前ロール（任意）"
        id="fe7-invite-role"
        value={roleId}
        roles={roles.data?.items}
        onChange={setRoleId}
        includeNone
        testId="fe7-invite-role"
      />
      <FormError>{formError}</FormError>
      <DialogActions>
        <Button variant="secondary" onClick={onClose} testId="fe7-invite-cancel">キャンセル</Button>
        <Button variant="primary" onClick={submit} disabled={invite.isPending} testId="fe7-invite-submit">
          招待する
        </Button>
      </DialogActions>
    </Modal>
  );
}
