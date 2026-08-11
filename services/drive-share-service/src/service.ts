// Business orchestration over the DriveShareClient seam. Keeps the routes thin and
// the Google specifics out of app.ts. Rules enforced here (not in the client):
//   • grant/update target only reader|commenter|writer — `owner` is never assignable
//     via the manager (ownership transfer is a deliberate, out-of-scope operation);
//   • link sharing is expressed as create/delete of the single `anyone` permission,
//     composed from listPermissions so the toggle is idempotent.
import { errors } from "@dub/errors";
import type { DriveShareClient } from "./drive-client";
import type { DriveShareConfig } from "./env";
import type {
  GrantPermissionRequest,
  ListFilesResult,
  ListPermissionsResult,
  SetLinkSharingRequest,
  SharePermission,
  ShareRole,
  UpdatePermissionRequest,
} from "./types";

const ASSIGNABLE: ReadonlySet<ShareRole> = new Set(["reader", "commenter", "writer"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface ListFilesArgs {
  folderId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface DriveShareService {
  listFiles(args: ListFilesArgs): Promise<ListFilesResult>;
  listPermissions(fileId: string): Promise<ListPermissionsResult>;
  grant(fileId: string, req: GrantPermissionRequest): Promise<SharePermission>;
  updateRole(fileId: string, permissionId: string, req: UpdatePermissionRequest): Promise<SharePermission>;
  revoke(fileId: string, permissionId: string): Promise<void>;
  setLinkSharing(fileId: string, req: SetLinkSharingRequest): Promise<ListPermissionsResult>;
}

function assertAssignable(role: ShareRole): void {
  if (!ASSIGNABLE.has(role)) {
    throw errors.validationFailed([{ field: "role", reason: "not_assignable" }], "指定できないロールです");
  }
}

export function createDriveShareService(deps: {
  client: DriveShareClient;
  config: DriveShareConfig;
}): DriveShareService {
  const { client, config } = deps;

  return {
    listFiles(args: ListFilesArgs): Promise<ListFilesResult> {
      const pageSize = Math.min(Math.max(args.limit ?? config.listPageSize, 1), 200);
      return client.listFiles({
        pageSize,
        ...(args.folderId ? { folderId: args.folderId } : {}),
        ...(args.q ? { q: args.q } : {}),
        ...(args.cursor ? { pageToken: args.cursor } : {}),
      });
    },

    listPermissions(fileId: string): Promise<ListPermissionsResult> {
      return client.listPermissions(fileId);
    },

    async grant(fileId: string, req: GrantPermissionRequest): Promise<SharePermission> {
      const email = req.emailAddress?.trim() ?? "";
      if (!EMAIL_RE.test(email)) {
        throw errors.validationFailed([{ field: "emailAddress", reason: "invalid_email" }], "メールアドレスの形式が不正です");
      }
      assertAssignable(req.role);
      return client.createPermission(fileId, { type: "user", role: req.role, emailAddress: email });
    },

    async updateRole(fileId: string, permissionId: string, req: UpdatePermissionRequest): Promise<SharePermission> {
      assertAssignable(req.role);
      return client.updatePermission(fileId, permissionId, req.role);
    },

    revoke(fileId: string, permissionId: string): Promise<void> {
      return client.deletePermission(fileId, permissionId);
    },

    async setLinkSharing(fileId: string, req: SetLinkSharingRequest): Promise<ListPermissionsResult> {
      const current = await client.listPermissions(fileId);
      const existingAnyone = current.permissions.find((p) => p.type === "anyone");
      if (req.enabled) {
        const role: ShareRole = req.role ?? "reader";
        assertAssignable(role);
        // createPermission on type=anyone upserts the single anyone permission.
        await client.createPermission(fileId, { type: "anyone", role });
      } else if (existingAnyone) {
        await client.deletePermission(fileId, existingAnyone.id);
      }
      return client.listPermissions(fileId);
    },
  };
}
