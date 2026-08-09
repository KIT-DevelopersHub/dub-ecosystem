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

export type FileLinkTargetType = "task" | "event" | "action" | "message";
export interface FileMetaLink {
  fileId: FileId;
  targetType: FileLinkTargetType;
  targetId: string;
  linkedAt: ISODateTime;
}
