import { useMemo, useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, Card, TextField, Button, ConfirmDialog, FormField } from "@dub/ui";
import { PermissionMatrix } from "./PermissionMatrix";
import { useRoles, usePermissionCatalog, useCreateRole, useUpdateRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { buildRoleUpdate, lockedKeysForRole } from "../lib/permissionMatrix";
import { errorMessage } from "../lib/errorDisplay";

// roleId omitted -> create mode.
export function RoleEditorPage({ roleId, onDone }: { roleId?: string; onDone?: () => void }) {
  const catalog = usePermissionCatalog();
  const roles = useRoles();
  const create = useCreateRole();
  const update = useUpdateRole(roleId ?? "");
  const { can } = usePermissions();
  const { toast } = useToast();

  const existing = useMemo(() => roles.data?.items.find((r) => r.id === roleId), [roles.data, roleId]);
  const [name, setName] = useState(existing?.name ?? "");
  const [perms, setPerms] = useState<identity.PermissionKey[]>(existing?.permissions ?? []);
  const [confirmSave, setConfirmSave] = useState(false);

  // Sync once existing loads (create mode stays empty).
  const [hydrated, setHydrated] = useState(false);
  if (existing && !hydrated) {
    setName(existing.name);
    setPerms(existing.permissions);
    setHydrated(true);
  }

  // System roles are editable by admins now; only the identity:admin gate blocks it.
  const readOnly = !can("identity:admin");
  // Renaming a system role is still disallowed (its name identifies it, e.g. "admin").
  const nameDisabled = readOnly || !!existing?.isSystem;
  const lockedKeys = existing ? lockedKeysForRole(existing) : [];

  function save() {
    setConfirmSave(false);
    if (lockedKeys.some((k) => !perms.includes(k))) {
      toast({ kind: "error", title: "この権限は外せません", description: "admin ロールから identity:admin は削除できません。" });
      return;
    }
    if (roleId && existing) {
      const patch = buildRoleUpdate({ name: existing.name, permissions: existing.permissions }, { name, permissions: perms });
      if (!patch) { toast({ kind: "info", title: "変更はありません" }); return; }
      update.mutate(patch, {
        onSuccess: () => { toast({ kind: "success", title: "ロールを保存しました" }); onDone?.(); },
        onError: (err) => toast({ kind: "error", title: "保存に失敗しました", description: errorMessage(err) }),
      });
    } else {
      create.mutate({ name, permissions: perms }, {
        onSuccess: () => { toast({ kind: "success", title: "ロールを作成しました" }); onDone?.(); },
        onError: (err) => toast({ kind: "error", title: "作成に失敗しました", description: errorMessage(err) }),
      });
    }
  }

  return (
    <div>
      <PageHeader title={roleId ? "ロールを編集" : "ロールを作成"} testId="fe7-role-editor-header" />
      <Card testId="fe7-role-editor">
        <FormField label="ロール名" htmlFor="fe7-role-name">
          <TextField id="fe7-role-name" value={name} onChange={(v) => setName(v)} disabled={nameDisabled} testId="fe7-role-name" />
        </FormField>
        {catalog.data ? (
          <PermissionMatrix catalog={catalog.data} selected={perms} disabled={readOnly} onChange={setPerms} lockedKeys={lockedKeys} />
        ) : (
          <p>権限カタログを読み込み中…</p>
        )}
        {!readOnly ? (
          <Button variant="primary" onClick={() => setConfirmSave(true)} disabled={!name.trim()} testId="fe7-role-save">保存</Button>
        ) : (
          <p>編集権限がありません。</p>
        )}
      </Card>
      <ConfirmDialog
        title="権限束を保存"
        message="ロールの権限を保存します。付与済みユーザーの実効権限に影響します。"
        open={confirmSave}
        onConfirm={save}
        onCancel={() => setConfirmSave(false)}
        testId="fe7-role-save-confirm"
      />
    </div>
  );
}
