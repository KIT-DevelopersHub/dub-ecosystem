// DriveShare feature api adapter. Like mail, it rides the ONE shell api-client
// (src/lib/api-client.tsx): session cookie, 401→refresh, requestId, error
// normalization. Callers never write fetch and never paste a token — the browser
// session authorizes every call, and the gateway forwards x-dub-user-id to
// drive-share-service, which authorizes drive:read / drive:write.
//
// Types are declared locally (not in @dub/types): drive:read/drive:write and the
// Drive sharing shapes are not in the frozen contract yet, exactly like the backend.
import type { ApiClient } from "../../lib/api-client.tsx";

export type ShareRole = "reader" | "commenter" | "writer" | "owner";
export type AssignableRole = "reader" | "commenter" | "writer";
export type GranteeType = "user" | "group" | "domain" | "anyone";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  ownerName: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  linkShared: boolean;
}

export interface SharePermission {
  id: string;
  type: GranteeType;
  role: ShareRole;
  emailAddress: string | null;
  displayName: string | null;
  domain: string | null;
}

export interface ListFilesResult {
  files: DriveFile[];
  nextCursor: string | null;
}

export interface ListPermissionsResult {
  fileId: string;
  permissions: SharePermission[];
}

export interface ListFilesQuery {
  q?: string;
  folderId?: string;
  cursor?: string;
  limit?: number;
}

export interface DriveShareApi {
  /** List files/folders in the Hackit shared Drive (drive:read). */
  listFiles(query?: ListFilesQuery): Promise<ListFilesResult>;
  /** List one file's sharing entries (drive:read). */
  listPermissions(fileId: string): Promise<ListPermissionsResult>;
  /** Grant a role to an email (drive:write). */
  grant(fileId: string, req: { emailAddress: string; role: AssignableRole }): Promise<{ permission: SharePermission }>;
  /** Change an existing permission's role (drive:write). */
  updateRole(fileId: string, permissionId: string, role: AssignableRole): Promise<{ permission: SharePermission }>;
  /** Revoke a permission (drive:write). */
  revoke(fileId: string, permissionId: string): Promise<{ revoked: boolean }>;
  /** Turn link (anyone-with-the-link) sharing on/off (drive:write). */
  setLinkSharing(fileId: string, req: { enabled: boolean; role?: AssignableRole }): Promise<ListPermissionsResult>;
}

const BASE = "/api/v1/driveshare";

export function createDriveShareApi(api: ApiClient): DriveShareApi {
  return {
    listFiles: (query) => {
      const q: Record<string, string | number | boolean | undefined> = {};
      if (query?.q !== undefined) q.q = query.q;
      if (query?.folderId !== undefined) q.folderId = query.folderId;
      if (query?.cursor !== undefined) q.cursor = query.cursor;
      if (query?.limit !== undefined) q.limit = query.limit;
      const hasQuery = Object.keys(q).length > 0;
      return api.request<ListFilesResult>({ method: "GET", path: `${BASE}/files`, ...(hasQuery ? { query: q } : {}) });
    },
    listPermissions: (fileId) =>
      api.request<ListPermissionsResult>({
        method: "GET",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions`,
      }),
    grant: (fileId, req) =>
      api.request<{ permission: SharePermission }>({
        method: "POST",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions`,
        body: req,
      }),
    updateRole: (fileId, permissionId, role) =>
      api.request<{ permission: SharePermission }>({
        method: "PATCH",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
        body: { role },
      }),
    revoke: (fileId, permissionId) =>
      api.request<{ revoked: boolean }>({
        method: "DELETE",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
      }),
    setLinkSharing: (fileId, req) =>
      api.request<ListPermissionsResult>({
        method: "PUT",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/link`,
        body: req,
      }),
  };
}

// ---- pure helpers (unit-tested) ----

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Japanese label for a Drive role, used across the UI. */
export function roleLabel(role: ShareRole): string {
  switch (role) {
    case "owner":
      return "オーナー";
    case "writer":
      return "編集者";
    case "commenter":
      return "コメント可";
    case "reader":
      return "閲覧者";
  }
}
