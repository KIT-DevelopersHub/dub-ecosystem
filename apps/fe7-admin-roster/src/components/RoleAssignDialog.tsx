import { useState } from "react";
import { Modal, Select, Button, uiStyles as s } from "../ui/primitives";
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
      <Select label="ロール" value={roleId} onChange={(e) => setRoleId(e.target.value)} testId="fe7-assign-role">
        <option value="">選択してください</option>
        {roles.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select>
      <ScopePicker value={scope} events={events} onChange={setScope} />
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      <div className={s.modalActions}>
        <Button onClick={onClose} testId="fe7-assign-cancel">キャンセル</Button>
        <Button variant="primary" onClick={submit} disabled={assign.isPending} testId="fe7-assign-submit">付与する</Button>
      </div>
    </Modal>
  );
}
