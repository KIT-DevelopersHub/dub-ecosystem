// Inline permission editor for a SINGLE existing role, rendered in place inside the
// role list accordion (design: "1画面で権限を確認・編集"). This removes the need to
// navigate to a separate role-editor screen just to see or change a role's permissions.
//
// Create-mode and the standalone /admin/roles/new screen still live in RoleEditorPage;
// this component only edits an already-loaded role.
import { useState } from "react";
import type { identity } from "@dub/types";
import { TextField, Button, ConfirmDialog, FormField } from "@dub/ui";
import { PermissionMatrix } from "./PermissionMatrix";
import { usePermissionCatalog, useUpdateRole, useChatDeletionPolicy, useUpdateChatDeletionPolicy } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { buildRoleUpdate, lockedKeysForRole } from "../lib/permissionMatrix";
import { chatDeleteRight, chatDeletionTier } from "../lib/chatDeleteRight";
import { errorMessage } from "../lib/errorDisplay";
import type { chat } from "@dub/types";

const noteStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 13, marginTop: 8 };
const actionsStyle: React.CSSProperties = { marginTop: 12 };

export function RolePermissionsEditor({ role }: { role: identity.Role }) {
  const catalog = usePermissionCatalog();
  const update = useUpdateRole(role.id);
  const policy = useChatDeletionPolicy();
  const updatePolicy = useUpdateChatDeletionPolicy();
  const { can } = usePermissions();
  const { toast } = useToast();

  // Each editor instance seeds from its own role; it is mounted only while expanded,
  // so opening a different role always starts from that role's saved state.
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<identity.PermissionKey[]>([...role.permissions]);
  const [confirmSave, setConfirmSave] = useState(false);

  // System roles are now editable by admins; only the identity:admin authz gate
  // blocks editing. Deletion of system roles stays blocked (RoleListPage).
  const readOnly = !can("identity:admin");
  // Keys that cannot be toggled off (admin role must keep identity:admin).
  const lockedKeys = lockedKeysForRole(role);
  // testid namespace so multiple accordions never collide (matrix keys are shared).
  const ns = `fe7-role-${role.id}`;

  // 削除時の挙動 (org-wide policy) is bound to the tier this role's 削除権限 maps to
  // (複数削除 → moderator, otherwise → member). Editing it saves the workspace policy
  // optimistically — independent of the role's 保存 button (different scope).
  const deleteTier = chatDeletionTier(chatDeleteRight(perms));
  const chatDeletion = policy.data
    ? {
        behavior: policy.data.policy[deleteTier],
        onBehaviorChange: (mode: chat.MessageDeletionMode) => {
          const cur = policy.data!;
          if (cur.policy[deleteTier] === mode) return;
          updatePolicy.mutate({ policy: { ...cur.policy, [deleteTier]: mode }, version: cur.version });
        },
        behaviorDisabled: readOnly || updatePolicy.isPending,
      }
    : undefined;

  function save() {
    setConfirmSave(false);
    // Defense-in-depth: never let the admin role lose identity:admin (self-lockout).
    if (lockedKeys.some((k) => !perms.includes(k))) {
      toast({ kind: "error", title: "この権限は外せません", description: "admin ロールから identity:admin は削除できません。" });
      return;
    }
    const patch = buildRoleUpdate({ name: role.name, permissions: role.permissions }, { name, permissions: perms });
    if (!patch) {
      toast({ kind: "info", title: "変更はありません" });
      return;
    }
    update.mutate(patch, {
      onSuccess: () => toast({ kind: "success", title: "ロールを保存しました" }),
      onError: (err) => toast({ kind: "error", title: "保存に失敗しました", description: errorMessage(err) }),
    });
  }

  return (
    <div data-testid={`fe7-role-inline-${role.id}`}>
      {!role.isSystem ? (
        <FormField label="ロール名" htmlFor={`${ns}-name`}>
          <TextField id={`${ns}-name`} value={name} onChange={(v) => setName(v)} disabled={readOnly} testId={`${ns}-name`} />
        </FormField>
      ) : null}
      {catalog.data ? (
        <PermissionMatrix catalog={catalog.data} selected={perms} disabled={readOnly} onChange={setPerms} idPrefix={ns} lockedKeys={lockedKeys} {...(chatDeletion ? { chatDeletion } : {})} />
      ) : (
        <p>権限カタログを読み込み中…</p>
      )}
      {readOnly ? (
        <p style={noteStyle}>編集権限がありません。</p>
      ) : (
        <div style={actionsStyle}>
          {lockedKeys.length > 0 ? (
            <p style={noteStyle}>admin ロールの identity:admin は締め出し防止のため外せません。</p>
          ) : null}
          <Button variant="primary" onClick={() => setConfirmSave(true)} disabled={!name.trim() || update.isPending} testId={`${ns}-save`}>
            保存
          </Button>
        </div>
      )}
      <ConfirmDialog
        title="権限束を保存"
        message="ロールの権限を保存します。付与済みユーザーの実効権限に影響します。"
        open={confirmSave}
        onConfirm={save}
        onCancel={() => setConfirmSave(false)}
        testId={`${ns}-save-confirm`}
      />
    </div>
  );
}
