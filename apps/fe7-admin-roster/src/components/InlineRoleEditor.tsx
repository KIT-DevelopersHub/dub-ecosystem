// Inline ロール editor for a SINGLE roster row. Renders the user's org-wide roles as
// chips DIRECTLY in the list's ロール column (design: "一覧で詳細が見えている") and, for
// admins, lets them add/remove roles IN PLACE via a popover checklist — no navigation to
// a per-user screen. Edits are optimistic (useAssignRoleInline / useRevokeRoleInline):
// the chip updates instantly and rolls back on error.
//
// The chips read from `user.roleIds` (already on the list row — no per-row fetch). The
// popover lazily fetches the user's assignments only while open, to resolve the
// assignment id an org-wide revoke needs.
import type { identity } from "@dub/types";
import { Badge, Popover, Checkbox, Spinner, type BadgeTone } from "@dub/ui";
import { useUserRoles, useAssignRoleInline, useRevokeRoleInline } from "../hooks/useRosterApi";
import type { RosterUser } from "../contracts/pending";

const cellStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" };
const chipsStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 };
const emptyStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 13 };
const triggerStyle: React.CSSProperties = { color: "var(--dub-color-accent-fg, #0969da)", fontSize: 12, fontWeight: 600 };
const panelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minWidth: 200 };
const panelTitleStyle: React.CSSProperties = { fontWeight: 600, fontSize: 13, marginBottom: 2 };
const panelHintStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 12, margin: 0 };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };

/** System roles get a distinct tone so admin/organizer read at a glance. */
function roleTone(name: string): BadgeTone {
  if (name === "admin") return "danger";
  if (name === "organizer") return "info";
  if (name === "member") return "neutral";
  return "brand";
}

export function InlineRoleEditor({
  user,
  roles,
  currentUserId,
  canAdmin,
}: {
  user: RosterUser;
  roles: identity.Role[];
  currentUserId: string;
  canAdmin: boolean;
}) {
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const assigned = user.roleIds;

  return (
    // Stop row clicks from bubbling to the DataTable's onRowClick (which opens the
    // right-hand management pane) — role edits stay self-contained in this cell.
    <div style={cellStyle} data-testid={`fe7-user-roles-${user.id}`} onClick={(e) => e.stopPropagation()}>
      <div style={chipsStyle}>
        {assigned.length === 0 ? (
          <span style={emptyStyle} data-testid={`fe7-roles-empty-${user.id}`}>
            ロールなし
          </span>
        ) : (
          assigned.map((roleId) => (
            <Badge key={roleId} tone={roleTone(roleName(roleId))} testId={`fe7-role-chip-${user.id}-${roleId}`}>
              {roleName(roleId)}
            </Badge>
          ))
        )}
      </div>
      {canAdmin ? (
        <Popover placement="bottom" testId={`fe7-inline-role-edit-${user.id}`} trigger={<span style={triggerStyle}>編集</span>}>
          <RolePopoverPanel user={user} roles={roles} currentUserId={currentUserId} />
        </Popover>
      ) : null}
    </div>
  );
}

/** Mounted only while the popover is open (Popover renders children on open), so the
 *  assignments fetch is lazy — one query per actively-edited row. */
function RolePopoverPanel({ user, roles, currentUserId }: { user: RosterUser; roles: identity.Role[]; currentUserId: string }) {
  const assignments = useUserRoles(user.id);
  const assign = useAssignRoleInline(user.id, currentUserId);
  const revoke = useRevokeRoleInline(user.id);

  const assignedIds = new Set(user.roleIds);
  // roleId -> org-wide assignment id (needed to revoke). Event-scoped rows are ignored.
  const orgAssignmentByRole = new Map<string, string>();
  for (const a of assignments.data ?? []) {
    if (a.resourceType === null) orgAssignmentByRole.set(a.roleId, a.id);
  }

  const busy = assign.isPending || revoke.isPending;

  function toggle(role: identity.Role, next: boolean) {
    if (next) {
      assign.mutate({ roleId: role.id, roleName: role.name });
    } else {
      const assignmentId = orgAssignmentByRole.get(role.id);
      if (!assignmentId) return; // assignments not loaded yet — toggle stays disabled
      revoke.mutate({ assignmentId, roleId: role.id });
    }
  }

  return (
    <div style={panelStyle} data-testid={`fe7-inline-role-panel-${user.id}`}>
      <div style={panelTitleStyle}>ロールを割り当て</div>
      {roles.length === 0 ? (
        <p style={panelHintStyle}>選択できるロールがありません</p>
      ) : (
        roles.map((role) => {
          const checked = assignedIds.has(role.id);
          // Can't revoke until we know the assignment id (org-wide row loaded).
          const revokeBlocked = checked && !orgAssignmentByRole.has(role.id) && !assignments.isLoading;
          return (
            <div style={rowStyle} key={role.id}>
              <Checkbox
                id={`fe7-inline-role-${user.id}-${role.id}`}
                checked={checked}
                disabled={busy || assignments.isLoading || revokeBlocked}
                onChange={(next) => toggle(role, next)}
                label={role.name}
                testId={`fe7-inline-role-toggle-${user.id}-${role.id}`}
              />
              {checked && role.isSystem ? <Badge tone="neutral">system</Badge> : null}
            </div>
          );
        })
      )}
      {busy || assignments.isLoading ? <Spinner /> : null}
    </div>
  );
}
