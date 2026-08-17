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
  /** Present only when requested via the field mask (and populated by Drive for items
   *  that inherit permissions from an ancestor folder / shared drive). Each entry is a
   *  source of the effective permission; `inherited=true` means it comes from an
   *  ancestor and cannot be edited/removed on this item. */
  permissionDetails?: { inherited?: boolean }[];
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
  // A permission is "inherited" (and thus not deletable/editable on this item) only
  // when EVERY permissionDetails source is inherited. If any source is direct
  // (inherited=false) the grant is present on this item and can be modified — e.g. the
  // owner row carries both an inherited `writer` detail and a direct `owner` detail.
  const details = p.permissionDetails ?? [];
  const inherited = details.length > 0 && details.every((d) => d.inherited === true);
  return {
    id: p.id ?? "",
    type: asType(p.type),
    role: asRole(p.role),
    emailAddress: p.emailAddress ?? null,
    displayName: p.displayName ?? null,
    domain: p.domain ?? null,
    inherited,
  };
}

// Well-known Drive 403 `reason` strings → user-facing Japanese. Anything not listed
// falls back to a generic (reason-tagged) message so the cause is never fully hidden.
const FORBIDDEN_REASON_JA: Record<string, string> = {
  cannotDeletePermission:
    "この権限は親フォルダから継承されているため、このファイル単体では剥奪できません。親フォルダの共有設定で操作してください。",
  cannotModifyInheritedPermission:
    "この権限は親フォルダから継承されているため、このファイル単体では変更できません。親フォルダの共有設定で操作してください。",
  insufficientFilePermissions:
    "この操作を行う権限がありません（このファイルのオーナーではありません）。",
  cannotRemoveOwnerPermission: "オーナー権限は剥奪できません。",
  cannotModifyOwnerPermission: "オーナー権限は変更できません。",
};

/** Convert a non-2xx Google Drive response into a DubError (no raw Google leak). */
export function mapGoogleError(status: number, body: unknown, retryAfterSec?: number): DubError {
  const reason = extractGoogleReason(body);
  switch (status) {
    case 400:
      return errors.validationFailed([{ field: "request", reason: reason ?? "invalid_request" }], "Drive rejected the request");
    case 401:
      return errors.upstreamUnavailable("google:auth");
    case 403: {
      // insufficient scope / not the owner / inherited permission / sharing policy.
      // Translate the well-known Drive reasons into a message the manager can show as-is
      // (Japanese) instead of leaking the raw reason string to the user.
      const ja = reason ? FORBIDDEN_REASON_JA[reason] : undefined;
      if (ja) return errors.forbidden(ja);
      return errors.forbidden(`Drive で操作が拒否されました${reason ? `（${reason}）` : ""}`);
    }
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
