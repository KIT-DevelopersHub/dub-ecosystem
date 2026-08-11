import { useState } from "react";
import { Modal, Button } from "@dub/ui";
import { RolePicker, DialogActions, FormError } from "@dub/app-ui";
import { ScopePicker } from "./ScopePicker";
import { useRoles, useAssignRole } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { DEFAULT_SCOPE, buildAssignRequest, type ScopeSelection } from "../lib/scope";
import { errorMessage } from "../lib/errorDisplay";

export function RoleAssignDialog({
  open,
  userId,
  grantedBy,
  events,
  onClose,
}: {
  open: boolean;
  userId: string;
  grantedBy: string;
  events: { id: string; name: string }[];
  onClose: () => void;
}) {
  const roles = useRoles();
  const assign = useAssignRole(userId, grantedBy);
  const { toast } = useToast();
  const [roleId, setRoleId] = useState("");
  const [scope, setScope] = useState<ScopeSelection>(DEFAULT_SCOPE);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (!roleId) { setError("ロールを選択してください"); return; }
    const roleName = roles.data?.items.find((r) => r.id === roleId)?.name ?? roleId;
    assign.mutate(
      { req: buildAssignRequest(roleId, scope), roleName },
      {
        onSuccess: () => { toast({ kind: "success", title: "ロールを付与しました" }); onClose(); },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <Modal title="ロールを付与" open={open} onClose={onClose} testId="fe7-assign-dialog">
      <RolePicker
        id="fe7-assign-role"
        value={roleId}
        roles={roles.data?.items}
        placeholder="選択してください"
        onChange={setRoleId}
        testId="fe7-assign-role"
      />
      <ScopePicker value={scope} events={events} onChange={setScope} />
      <FormError>{error}</FormError>
      <DialogActions>
        <Button variant="secondary" onClick={onClose} testId="fe7-assign-cancel">キャンセル</Button>
        <Button variant="primary" onClick={submit} disabled={assign.isPending} testId="fe7-assign-submit">付与する</Button>
      </DialogActions>
    </Modal>
  );
}
