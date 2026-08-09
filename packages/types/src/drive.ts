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
  parentId?: DriveFileId;
  // limit max 100 (Drive API constraint)
}
export type ListFilesResponse = Paginated<DriveFile>;
export interface GetEmbedResponse {
  embedUrl: string;
}
export interface GetSheetValuesResponse {
  values: string[][];
}
