// fileMeta — file-meta namespace (file metadata + links registry).
import type { FileId, UserId, ISODateTime, Paginated, CursorQuery } from "./common";

export type FileVisibility = "org" | "private";

export interface FileMeta {
  id: FileId;
  name: string;
  mimeType: string;
  sizeBytes: number;
  ownerId: UserId;
  visibility: FileVisibility;
  driveFileId: string | null;
  r2Key: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
export interface RegisterMetaRequest {
  name: string;
  mimeType: string;
  sizeBytes: number;
  visibility?: FileVisibility;
  driveFileId?: string;
  r2Key?: string;
}
export interface FileSearchQuery extends CursorQuery {
  q?: string;
  mimeType?: string;
  ownerId?: UserId;
}
export type FileSearchResponse = Paginated<FileMeta>;

/** GET /files/meta/{id} optional expansion (comma-joined; `links` fetches the link rows). */
export interface GetMetaQuery {
  include?: string;
}

export type FileLinkTargetType = "task" | "event" | "action" | "message";
export interface FileMetaLink {
  fileId: FileId;
  targetType: FileLinkTargetType;
  targetId: string;
  linkedAt: ISODateTime;
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* file-meta's read endpoints
// put on the wire. The server (file-meta app.ts) and the OpenAPI spec
// (docs/openapi/file-meta.yaml) are reconciled against this map in CI (see @dub/e2e-smoke
// wire-params.test.ts). Renaming a key here is the only legitimate way to change a wire
// param. `deleteLink` is intentionally NOT listed: its targetType/targetId travel in the
// JSON body (the spec's `in: query` for them is a separate doc drift, tracked apart to
// keep this contract non-breaking). See docs/api-contracts/_wire-contract-enforcement.md.
export const FILE_META_WIRE = {
  searchFiles: { method: "GET", path: "/files/search", query: ["cursor", "limit", "q", "mimeType", "ownerId"] },
  getMeta: { method: "GET", path: "/files/meta/{id}", query: ["include"] },
} as const;

// Compile-time tie: every query key each endpoint lists must be a real key of its query
// type, so the descriptor and the hand-written types can never silently drift.
type _FileMetaWireKeysAreTyped =
  (typeof FILE_META_WIRE.searchFiles.query)[number] extends keyof FileSearchQuery
    ? (typeof FILE_META_WIRE.getMeta.query)[number] extends keyof GetMetaQuery
      ? true
      : never
    : never;
const _fileMetaWireKeyGuard: _FileMetaWireKeysAreTyped = true;
void _fileMetaWireKeyGuard;
