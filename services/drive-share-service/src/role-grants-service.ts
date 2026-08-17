// Role-based Drive sharing orchestration — the NON-DESTRUCTIVE, idempotent fan-out.
//
// Google Drive holds the actual permissions; this service only decides which Drive
// permissions to create/keep/delete so that "role X can <reader|commenter|writer> file
// Y" stays true, WITHOUT ever touching individual (pre-existing) shares. The safety
// mechanism is the member ledger (driveshare_role_grant_members): every row records
// whether WE created the Drive permission (created_by_us=1, safe to delete) or it
// pre-existed (created_by_us=0, never delete). Reconcile/revoke consult the ledger, so
// a hand-added individual share is invisible to us and survives.
//
// Correctness rules distilled:
//   apply (POST, upsert): additive + role-correcting. Create permissions for members
//     that have none; for members whose permission WE own, correct its role to the new
//     driveRole; NEVER modify a pre-existing permission. Departed-member cleanup is NOT
//     done here (that is reapply's job) — POST stays a pure add/upsert.
//   revoke (DELETE): delete ONLY the permissions we created, and only when no OTHER
//     grant on the same file still needs that email; then drop the grant + ledger.
//   reapply (reconcile): apply + remove departed members' permissions (our-only, guarded).
import { DubError, errors } from "@dub/errors";
import type { DriveShareClient } from "./drive-client";
import type { GrantMemberRow, GrantRow, RoleGrantStore } from "./role-grants-store";
import type { RoleMembership } from "./role-membership";
import type { AssignableDriveRole, InvitedMember, RoleFileGrant, SharePermission, SkippedMember } from "./types";

const ASSIGNABLE: ReadonlySet<string> = new Set(["reader", "commenter", "writer"]);

export interface RoleGrantsDeps {
  drive: DriveShareClient;
  /** Request-scoped role membership for the acting user (built in the composition root). */
  roster: RoleMembership;
  store: RoleGrantStore;
  orgId: string;
  now: () => string;
  newId: () => string;
}

export interface RoleGrantsService {
  listAll(): Promise<RoleFileGrant[]>;
  listByFile(fileId: string): Promise<RoleFileGrant[]>;
  apply(fileId: string, actingUserId: string, roleId: string, driveRole: AssignableDriveRole): Promise<RoleFileGrant>;
  revoke(fileId: string, roleId: string): Promise<void>;
  reapply(fileId: string, roleId: string): Promise<RoleFileGrant>;
}

/** Index a file's Drive permissions by lowercased user email (ignores anyone/domain). */
function indexUserPermsByEmail(perms: readonly SharePermission[]): Map<string, SharePermission> {
  const byEmail = new Map<string, SharePermission>();
  for (const p of perms) {
    if (p.type === "user" && p.emailAddress) byEmail.set(p.emailAddress.trim().toLowerCase(), p);
  }
  return byEmail;
}

export function createRoleGrantsService(deps: RoleGrantsDeps): RoleGrantsService {
  const { drive, roster, store, orgId, now, newId } = deps;

  function assertAssignable(driveRole: string): asserts driveRole is AssignableDriveRole {
    if (!ASSIGNABLE.has(driveRole)) {
      throw errors.validationFailed([{ field: "driveRole", reason: "not_assignable" }], "指定できないロールです");
    }
  }

  function assertRoleId(roleId: string): void {
    if (!roleId || !roleId.trim()) {
      throw errors.validationFailed([{ field: "roleId", reason: "required" }], "ロールIDは必須です");
    }
  }

  /** Reconcile the Drive permissions for a grant against its current role membership.
   *  Returns the freshly computed member ledger (already persisted) AND the members Drive
   *  refused (partial success — one bad email never fails the whole role fan-out). */
  async function reconcile(
    grant: GrantRow,
    driveRole: AssignableDriveRole,
    opts: { removeDeparted: boolean },
  ): Promise<{ members: GrantMemberRow[]; skipped: SkippedMember[]; invited: InvitedMember[] }> {
    const prev = await store.listMembers(grant.id);
    const prevByEmail = new Map(prev.map((m) => [m.email, m]));

    const emails = await roster.listActiveEmails(grant.roleId); // already lowercased+deduped
    const emailSet = new Set(emails);

    const perms = (await drive.listPermissions(grant.fileId)).permissions;
    const permByEmail = indexUserPermsByEmail(perms);

    const next: GrantMemberRow[] = [];
    const skipped: SkippedMember[] = [];
    const invited: InvitedMember[] = [];
    // Per-member isolation: a member Drive refuses (bad/non-Google email) is recorded in
    // `skipped` and the loop continues, so the rest of the role is still applied.
    const reasonFor = (err: unknown): string =>
      err instanceof DubError ? err.message : "共有できませんでした。";
    // A create that only went through via the invite fallback (no Google account) is
    // recorded so the operator learns the access is pending.
    const noteInvited = (email: string, perm: SharePermission): void => {
      if (perm.invited) invited.push({ email });
    };

    for (const email of emails) {
      const previous = prevByEmail.get(email);
      const live = permByEmail.get(email);

      try {
        if (previous && previous.createdByUs === 1) {
          // We own this member's permission.
          if (live && live.id === previous.permissionId) {
            // Still ours — correct the role if it drifted (e.g. driveRole changed on upsert).
            if (live.role !== driveRole) await drive.updatePermission(grant.fileId, live.id, driveRole);
            next.push({ grantId: grant.id, email, permissionId: live.id, createdByUs: 1 });
          } else if (live) {
            // Our recorded permission is gone but a (now pre-existing) one exists — respect it.
            next.push({ grantId: grant.id, email, permissionId: live.id, createdByUs: 0 });
          } else {
            // Externally deleted — recreate ours.
            const created = await drive.createPermission(grant.fileId, { type: "user", role: driveRole, emailAddress: email });
            noteInvited(email, created);
            next.push({ grantId: grant.id, email, permissionId: created.id, createdByUs: 1 });
          }
        } else if (live) {
          // Not previously ours and a permission already exists — pre-existing individual
          // share. Record it (created_by_us=0) and NEVER modify it.
          next.push({ grantId: grant.id, email, permissionId: live.id, createdByUs: 0 });
        } else {
          // New member with no permission — create ours.
          const created = await drive.createPermission(grant.fileId, { type: "user", role: driveRole, emailAddress: email });
          noteInvited(email, created);
          next.push({ grantId: grant.id, email, permissionId: created.id, createdByUs: 1 });
        }
      } catch (err) {
        skipped.push({ email, reason: reasonFor(err) });
      }
    }

    if (opts.removeDeparted) {
      for (const m of prev) {
        if (emailSet.has(m.email)) continue; // still a member
        if (m.createdByUs === 1 && m.permissionId) {
          // Our permission, member departed — delete unless another grant still needs it.
          const held = await store.emailHeldByOtherGrant(orgId, grant.fileId, grant.id, m.email);
          if (!held) await drive.deletePermission(grant.fileId, m.permissionId);
        }
        // created_by_us=0 departed: just forget the row; never delete an individual share.
      }
    }

    await store.replaceMembers(grant.id, next);
    return { members: next, skipped, invited };
  }

  async function toRoleFileGrant(grant: GrantRow, extra?: { skipped?: SkippedMember[]; invited?: InvitedMember[] }): Promise<RoleFileGrant> {
    const [emails, members, roleName] = await Promise.all([
      roster.listActiveEmails(grant.roleId),
      store.listMembers(grant.id),
      roster.roleName(grant.roleId),
    ]);
    return {
      id: grant.id,
      fileId: grant.fileId,
      roleId: grant.roleId,
      roleName: roleName ?? grant.roleId,
      driveRole: grant.driveRole,
      memberCount: emails.length,
      appliedCount: members.length,
      grantedBy: grant.grantedBy,
      grantedAt: grant.grantedAt,
      ...(extra?.skipped && extra.skipped.length > 0 ? { skipped: extra.skipped } : {}),
      ...(extra?.invited && extra.invited.length > 0 ? { invited: extra.invited } : {}),
    };
  }

  return {
    async listAll(): Promise<RoleFileGrant[]> {
      const grants = await store.listGrants(orgId);
      return Promise.all(grants.map((g) => toRoleFileGrant(g)));
    },

    async listByFile(fileId: string): Promise<RoleFileGrant[]> {
      const grants = await store.listGrantsByFile(orgId, fileId);
      return Promise.all(grants.map((g) => toRoleFileGrant(g)));
    },

    async apply(fileId, actingUserId, roleId, driveRole): Promise<RoleFileGrant> {
      assertRoleId(roleId);
      assertAssignable(driveRole);
      const existing = await store.getGrant(orgId, fileId, roleId);
      const ts = now();
      const grant = await store.upsertGrant({
        id: existing?.id ?? newId(),
        orgId,
        fileId,
        roleId,
        driveRole,
        grantedBy: existing?.grantedBy ?? actingUserId,
        grantedAt: existing?.grantedAt ?? ts,
        updatedAt: ts,
      });
      const { skipped, invited } = await reconcile(grant, driveRole, { removeDeparted: false });
      return toRoleFileGrant(grant, { skipped, invited });
    },

    async revoke(fileId, roleId): Promise<void> {
      assertRoleId(roleId);
      const grant = await store.getGrant(orgId, fileId, roleId);
      if (!grant) return; // idempotent
      const members = await store.listMembers(grant.id);
      for (const m of members) {
        if (m.createdByUs !== 1 || !m.permissionId) continue; // never delete pre-existing shares
        const held = await store.emailHeldByOtherGrant(orgId, fileId, grant.id, m.email);
        if (!held) await drive.deletePermission(fileId, m.permissionId);
      }
      await store.deleteGrant(grant.id);
    },

    async reapply(fileId, roleId): Promise<RoleFileGrant> {
      assertRoleId(roleId);
      const grant = await store.getGrant(orgId, fileId, roleId);
      if (!grant) throw errors.notFound("driveRoleGrant", `${fileId}:${roleId}`);
      const ts = now();
      const updated = await store.upsertGrant({ ...grant, updatedAt: ts });
      const { skipped, invited } = await reconcile(updated, updated.driveRole, { removeDeparted: true });
      return toRoleFileGrant(updated, { skipped, invited });
    },
  };
}
