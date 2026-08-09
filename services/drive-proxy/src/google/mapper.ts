// Pure mappers: Google resource -> frozen DriveFile, mimeType -> kind, embed URL
// derivation, and Google error -> DubError (design §6 conversion table). No I/O.
import { DubError, CommonErrorCodes, errors } from "@dub/errors";
import type { drive } from "@dub/types";
import type { DriveFileKind } from "../types";

/** Raw Google Drive file resource (subset we request via `fields`). */
export interface GoogleFileResource {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
  iconLink?: string;
  size?: string;
}

const GOOGLE_MIME: Record<string, DriveFileKind> = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slide",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.folder": "folder",
  "application/pdf": "pdf",
};

export function kindOf(mimeType: string): DriveFileKind {
  const mapped = GOOGLE_MIME[mimeType];
  if (mapped) return mapped;
  if (mimeType.startsWith("image/")) return "image";
  return "other";
}

/** Project a raw Google resource down to the frozen `@dub/types` DriveFile. */
export function toDriveFile(r: GoogleFileResource): drive.DriveFile {
  return {
    id: r.id,
    name: r.name,
    mimeType: r.mimeType,
    modifiedAt: r.modifiedTime ?? new Date(0).toISOString(),
  };
}

/** Embed/preview URL by kind. Folders are not embeddable -> VALIDATION_FAILED. */
export function embedUrlFor(id: string, kind: DriveFileKind): string {
  switch (kind) {
    case "doc":
      return `https://docs.google.com/document/d/${id}/preview`;
    case "sheet":
      return `https://docs.google.com/spreadsheets/d/${id}/preview`;
    case "slide":
      return `https://docs.google.com/presentation/d/${id}/embed`;
    case "form":
      return `https://docs.google.com/forms/d/${id}/viewform?embedded=true`;
    case "folder":
      throw errors.validationFailed(
        [{ field: "fileId", reason: "not_embeddable", message: "folders cannot be embedded" }],
        "Folder cannot be embedded",
      );
    case "pdf":
    case "image":
    case "other":
    default:
      return `https://drive.google.com/file/d/${id}/preview`;
  }
}

export function editUrlFor(id: string, kind: DriveFileKind, webViewLink?: string): string {
  switch (kind) {
    case "doc":
      return `https://docs.google.com/document/d/${id}/edit`;
    case "sheet":
      return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case "slide":
      return `https://docs.google.com/presentation/d/${id}/edit`;
    case "form":
      return `https://docs.google.com/forms/d/${id}/edit`;
    default:
      return webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
  }
}

interface GoogleErrorBody {
  error?: { message?: string; errors?: { reason?: string }[] };
}

/**
 * Convert a Google API non-2xx into a unified DubError (§6). The raw Google
 * error body is never leaked to clients (message kept generic for 5xx/credential).
 */
export function mapGoogleError(status: number, body: unknown, retryAfterSec?: number): DubError {
  const parsed = body as GoogleErrorBody | null;
  const gmsg = parsed?.error?.message;
  switch (status) {
    case 400:
      return new DubError(CommonErrorCodes.VALIDATION_FAILED, gmsg ?? "Google rejected the request", {
        status: 400,
        details: [{ field: "request", reason: "google_bad_request" }],
      });
    case 401:
      // credential/token problem after refresh+retry: log-only, no secret leak.
      return errors.upstreamUnavailable("google:auth");
    case 403:
      return new DubError(CommonErrorCodes.FORBIDDEN, gmsg ?? "Google denied access", { status: 403 });
    case 404:
      return errors.notFound("driveFile");
    case 409:
      return errors.conflict(gmsg ?? "Google reported a conflict");
    case 429:
      return errors.rateLimited(retryAfterSec ?? 1);
    case 500:
    case 502:
    case 503:
      return errors.upstreamUnavailable("google");
    case 504:
      return errors.upstreamTimeout("google");
    default:
      if (status >= 500) return errors.upstreamUnavailable("google");
      return errors.upstreamUnavailable("google");
  }
}
