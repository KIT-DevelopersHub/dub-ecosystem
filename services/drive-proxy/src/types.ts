// Service-local contract types that COMPLEMENT the frozen `@dub/types` drive
// namespace (which P0b only partially ported — it currently ships the thin
// DriveFile/CreateFileRequest/ListFilesQuery/GetEmbedResponse/GetSheetValuesResponse).
// The frozen package is the shared contract other services compile against, so we
// reuse it verbatim and only add shapes it does not yet declare. None of these
// names collide with the frozen namespace (see design §2-2; discrepancy noted in
// the service README).
import type { drive } from "@dub/types";

/** mimeType → coarse kind for embed-URL derivation (design §2-2 DriveFileKind). */
export type DriveFileKind =
  | "doc"
  | "sheet"
  | "slide"
  | "form"
  | "folder"
  | "pdf"
  | "image"
  | "other";

export interface CreateFileResponse {
  file: drive.DriveFile;
}

export interface MoveFileRequest {
  newParentId: drive.DriveFileId;
}
export interface MoveFileResponse {
  file: drive.DriveFile;
}
export interface TrashFileResponse {
  file: drive.DriveFile;
  trashed: true;
}

export interface GetSheetValuesQuery {
  range: string; // A1 notation
}
export interface WriteSheetValuesRequest {
  mode: "update" | "append";
  range: string;
  values: (string | number | boolean | null)[][];
}
export interface WriteSheetValuesResponse {
  spreadsheetId: drive.DriveFileId;
  updatedRange: string;
  updatedRows: number;
}

/** GET /drive/health/quota (internal-only, design §2-2 QuotaStatusResponse). */
export interface QuotaStatusResponse {
  windowSeconds: number;
  usedRequests: number;
  softLimit: number;
  throttling: boolean;
}
