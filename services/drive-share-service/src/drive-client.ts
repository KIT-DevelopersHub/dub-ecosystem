// The Drive-access seam. EVERYTHING that touches Google lives behind this interface,
// so the rest of the service (service.ts / app.ts) is identical whether it runs on the
// REAL Drive v3 client (google/client.ts) or the in-memory MOCK (mock-client.ts).
// index.ts picks one at composition time based on whether the Hackit OAuth secrets are
// bound. Swapping mock→real when the refresh token arrives is a one-line factory change.
import { errors, DubError } from "@dub/errors";
import type {
  DriveFile,
  GranteeType,
  ListFilesResult,
  ListPermissionsResult,
  ShareRole,
  SharePermission,
} from "./types";

export interface ListFilesParams {
  /** Restrict to direct children of this folder id. Omit for "My Drive" root scope. */
  folderId?: string;
  /** Substring name filter. */
  q?: string;
  pageToken?: string;
  pageSize: number;
}

export interface CreatePermissionParams {
  role: ShareRole;
  type: GranteeType;
  /** required for type=user/group */
  emailAddress?: string;
}

/** The single Drive-access contract. Implementations map Google resources to the
 *  domain shapes in types.ts, so no raw Google payload ever leaves this layer. */
export interface DriveShareClient {
  listFiles(p: ListFilesParams): Promise<ListFilesResult>;
  listPermissions(fileId: string): Promise<ListPermissionsResult>;
  createPermission(fileId: string, p: CreatePermissionParams): Promise<SharePermission>;
  updatePermission(fileId: string, permissionId: string, role: ShareRole): Promise<SharePermission>;
  deletePermission(fileId: string, permissionId: string): Promise<void>;
}

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

// ---- shared mapping helpers (used by the real client; mirrored by the mock) ----

interface GoogleUser {
  displayName?: string;
}
interface GoogleFileResource {
  id: string;
  name?: string;
  mimeType?: string;
  owners?: GoogleUser[];
  modifiedTime?: string;
  webViewLink?: string;
  permissions?: { id?: string; type?: string }[];
}
interface GooglePermissionResource {
  id?: string;
  type?: string;
  role?: string;
  emailAddress?: string;
  displayName?: string;
  domain?: string;
}

const ROLES: ReadonlySet<string> = new Set(["reader", "commenter", "writer", "owner"]);
const TYPES: ReadonlySet<string> = new Set(["user", "group", "domain", "anyone"]);

function asRole(raw: string | undefined): ShareRole {
  return raw && ROLES.has(raw) ? (raw as ShareRole) : "reader";
}
function asType(raw: string | undefined): GranteeType {
  return raw && TYPES.has(raw) ? (raw as GranteeType) : "user";
}

export function mapFile(f: GoogleFileResource): DriveFile {
  const mimeType = f.mimeType ?? "application/octet-stream";
  return {
    id: f.id,
    name: f.name ?? "(無題)",
    mimeType,
    isFolder: mimeType === DRIVE_FOLDER_MIME,
    ownerName: f.owners?.[0]?.displayName ?? null,
    modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? null,
    linkShared: (f.permissions ?? []).some((p) => p.type === "anyone"),
  };
}

export function mapPermission(p: GooglePermissionResource): SharePermission {
  return {
    id: p.id ?? "",
    type: asType(p.type),
    role: asRole(p.role),
    emailAddress: p.emailAddress ?? null,
    displayName: p.displayName ?? null,
    domain: p.domain ?? null,
  };
}

/** Convert a non-2xx Google Drive response into a DubError (no raw Google leak). */
export function mapGoogleError(status: number, body: unknown, retryAfterSec?: number): DubError {
  const reason = extractGoogleReason(body);
  switch (status) {
    case 400:
      return errors.validationFailed([{ field: "request", reason: reason ?? "invalid_request" }], "Drive rejected the request");
    case 401:
      return errors.upstreamUnavailable("google:auth");
    case 403:
      // insufficient scope / not the owner / sharing policy — surface as forbidden.
      return errors.forbidden(`Drive denied the operation${reason ? `: ${reason}` : ""}`);
    case 404:
      return errors.notFound("driveResource");
    case 429:
      return errors.rateLimited(retryAfterSec ?? 1);
    default:
      if (status >= 500) return errors.upstreamUnavailable("google");
      return errors.upstreamUnavailable("google");
  }
}

function extractGoogleReason(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
    return e?.errors?.[0]?.reason ?? e?.message;
  }
  return undefined;
}
