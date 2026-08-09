import { useState } from "react";
import { Modal, Select, Button, FormField, type SelectOption } from "@dub/ui";
import { ScopePicker } from "./ScopePicker";
import { useRoles, useAssignRole } from "../hooks/useRosterApi";
import { useToast } from "../hooks/useToast";
import { DEFAULT_SCOPE, buildAssignRequest, type ScopeSelection } from "../lib/scope";
import { errorMessage } from "../lib/errorDisplay";

const actionsRow: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 };
const formErrorStyle: React.CSSProperties = { color: "var(--dub-color-danger-600)", fontSize: 13, margin: "8px 0 0" };

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

  const roleOptions: SelectOption[] = roles.data?.items.map((r) => ({ value: r.id, label: r.name })) ?? [];

  return (
    <Modal title="ロールを付与" open={open} onClose={onClose} testId="fe7-assign-dialog">
      <FormField label="ロール" htmlFor="fe7-assign-role">
        <Select
          id="fe7-assign-role"
          value={roleId}
          options={roleOptions}
          placeholder="選択してください"
          onChange={(v) => setRoleId(v)}
          testId="fe7-assign-role"
        />
      </FormField>
      <ScopePicker value={scope} events={events} onChange={setScope} />
      {error ? <p style={formErrorStyle} role="alert">{error}</p> : null}
      <div style={actionsRow}>
        <Button variant="secondary" onClick={onClose} testId="fe7-assign-cancel">キャンセル</Button>
        <Button variant="primary" onClick={submit} disabled={assign.isPending} testId="fe7-assign-submit">付与する</Button>
      </div>
    </Modal>
  );
}
