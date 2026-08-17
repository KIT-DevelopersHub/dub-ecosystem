// drive — drive-proxy namespace. Drive raw ids live here (not promoted to common).
import type { ISODateTime, Paginated, CursorQuery } from "./common";

export type DriveFileId = string; // Google Drive raw id

export interface DriveFile {
  id: DriveFileId;
  name: string;
  mimeType: string;
  modifiedAt: ISODateTime;
}
export interface CreateFileRequest {
  name: string;
  mimeType: string;
  parentId?: DriveFileId;
}
export interface ListFilesQuery extends CursorQuery {
  /** Folder whose direct children to list. Canonical name — the server reads `folderId`
   *  (an earlier `parentId` in this type + the spec never matched the server and was a
   *  no-op; aligned to `folderId` here, non-breaking since `parentId` was never honored). */
  folderId?: DriveFileId;
  kind?: string; // file-kind filter (server reads it; was undocumented)
  q?: string; // free-text search (server reads it; was undocumented)
  // limit max 100 (Drive API constraint)
}
export type ListFilesResponse = Paginated<DriveFile>;
export interface GetEmbedResponse {
  embedUrl: string;
}
/** GET /drive/sheets/{id}/values — A1 range (e.g. "Sheet1!A1:C10"). */
export interface GetSheetValuesQuery {
  range?: string;
}
export interface GetSheetValuesResponse {
  values: string[][];
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* drive-proxy's read endpoints
// put on the wire. The server (drive-proxy app.ts) and the OpenAPI spec
// (docs/openapi/drive-proxy.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). Renaming a key here is the only legitimate way to
// change a wire param. See docs/api-contracts/_wire-contract-enforcement.md.
export const DRIVE_WIRE = {
  listDriveFiles: { method: "GET", path: "/drive/files", query: ["cursor", "limit", "folderId", "kind", "q"] },
  getSheetValues: { method: "GET", path: "/drive/sheets/{id}/values", query: ["range"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type.
type _DriveWireKeysAreTyped =
  (typeof DRIVE_WIRE.listDriveFiles.query)[number] extends keyof ListFilesQuery
    ? (typeof DRIVE_WIRE.getSheetValues.query)[number] extends keyof GetSheetValuesQuery
      ? true
      : never
    : never;
const _driveWireKeyGuard: _DriveWireKeysAreTyped = true;
void _driveWireKeyGuard;
