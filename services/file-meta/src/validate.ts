// Input validation helpers. Throws DubError(VALIDATION_FAILED) with FieldError[] so
// the FE form-error renderer works uniformly.
import { DubError, CommonErrorCodes, type FieldError } from "@dub/errors";
import type { fileMeta } from "@dub/types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// prefix-ULID form: <lower_snake>_<26 Crockford base32> (matches @dub/db newId()).
const PREFIX_ULID = /^[a-z][a-z0-9_]*_[0-9A-HJKMNP-TV-Z]{26}$/;
const VISIBILITY: readonly fileMeta.FileVisibility[] = ["org", "private"];
const TARGET_TYPES: readonly fileMeta.FileLinkTargetType[] = ["task", "event", "action", "message"];

export function fail(details: FieldError[]): never {
  throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "Validation failed", { status: 400, details });
}

export function isFileId(id: string): boolean {
  return PREFIX_ULID.test(id) && id.startsWith("file_");
}

/** Parse & clamp the CursorQuery limit (default 50, max 200; 0/negative/>max -> 400). */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    fail([{ field: "limit", reason: n > MAX_LIMIT ? "too_large" : "invalid" }]);
  }
  return n;
}

export interface ValidatedRegister {
  name: string;
  mimeType: string;
  sizeBytes: number;
  visibility: fileMeta.FileVisibility;
  driveFileId: string | null;
  r2Key: string | null;
}

export function validateRegister(body: fileMeta.RegisterMetaRequest): ValidatedRegister {
  const errs: FieldError[] = [];
  if (typeof body?.name !== "string" || body.name.trim() === "") errs.push({ field: "name", reason: "required" });
  if (typeof body?.mimeType !== "string" || body.mimeType.trim() === "") errs.push({ field: "mimeType", reason: "required" });
  if (typeof body?.sizeBytes !== "number" || !Number.isFinite(body.sizeBytes) || body.sizeBytes < 0) {
    errs.push({ field: "sizeBytes", reason: "invalid" });
  }
  const visibility = body?.visibility ?? "org";
  if (!VISIBILITY.includes(visibility)) errs.push({ field: "visibility", reason: "invalid" });
  const driveFileId = body?.driveFileId ?? null;
  const r2Key = body?.r2Key ?? null;
  if (driveFileId !== null && r2Key !== null) errs.push({ field: "driveFileId", reason: "mutually_exclusive" });
  if (errs.length > 0) fail(errs);
  return { name: body.name, mimeType: body.mimeType, sizeBytes: body.sizeBytes, visibility, driveFileId, r2Key };
}

export interface ValidatedUpdate {
  name?: string;
  visibility?: fileMeta.FileVisibility;
  ownerId?: string;
}
export function validateUpdate(body: Record<string, unknown>): ValidatedUpdate {
  const errs: FieldError[] = [];
  const out: ValidatedUpdate = {};
  if (body?.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") errs.push({ field: "name", reason: "invalid" });
    else out.name = body.name;
  }
  if (body?.visibility !== undefined) {
    if (!VISIBILITY.includes(body.visibility as fileMeta.FileVisibility)) errs.push({ field: "visibility", reason: "invalid" });
    else out.visibility = body.visibility as fileMeta.FileVisibility;
  }
  if (body?.ownerId !== undefined) {
    if (typeof body.ownerId !== "string" || body.ownerId.trim() === "") errs.push({ field: "ownerId", reason: "invalid" });
    else out.ownerId = body.ownerId;
  }
  if (errs.length > 0) fail(errs);
  return out;
}

export interface ValidatedLink {
  targetType: fileMeta.FileLinkTargetType;
  targetId: string;
}
export function validateLink(body: Record<string, unknown>): ValidatedLink {
  const errs: FieldError[] = [];
  const targetType = body?.targetType as fileMeta.FileLinkTargetType;
  if (!TARGET_TYPES.includes(targetType)) errs.push({ field: "targetType", reason: "invalid" });
  if (typeof body?.targetId !== "string" || body.targetId.trim() === "") errs.push({ field: "targetId", reason: "required" });
  if (errs.length > 0) fail(errs);
  return { targetType, targetId: body.targetId as string };
}
