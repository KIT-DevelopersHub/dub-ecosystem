// Google Drive v3 / Sheets v4 HTTP adapter. The ONLY place raw Google calls live.
// Every non-2xx is converted via mapGoogleError so no raw Google error leaks (§6).
// 401 triggers exactly one forced token refresh + retry. `fetchImpl` injectable.
import { errors } from "@dub/errors";
import { retryFetch } from "@dub/http";
import type { GoogleFileResource } from "./mapper";
import { mapGoogleError } from "./mapper";
import type { TokenProvider } from "./token";

export interface ListFilesParams {
  folderId: string;
  pageToken?: string;
  pageSize: number;
  kind?: string; // mime filter is resolved by caller into a Drive `q` clause
  q?: string;
}
export interface SheetWriteResult {
  updatedRange: string;
  updatedRows: number;
}
export interface SheetReadResult {
  range: string;
  values: (string | number | boolean | null)[][];
}

export interface GoogleDriveApi {
  listFiles(p: ListFilesParams): Promise<{ files: GoogleFileResource[]; nextPageToken: string | null }>;
  getFile(id: string): Promise<GoogleFileResource>;
  createFile(meta: { name: string; mimeType: string; parentId?: string }): Promise<GoogleFileResource>;
  copyFile(templateId: string, meta: { name: string; parentId?: string }): Promise<GoogleFileResource>;
  moveFile(id: string, newParentId: string, oldParents: string[]): Promise<GoogleFileResource>;
  trashFile(id: string): Promise<GoogleFileResource>;
  getSheetValues(spreadsheetId: string, range: string): Promise<SheetReadResult>;
  updateSheetValues(
    spreadsheetId: string,
    range: string,
    values: SheetReadResult["values"],
  ): Promise<SheetWriteResult>;
  appendSheetValues(
    spreadsheetId: string,
    range: string,
    values: SheetReadResult["values"],
  ): Promise<SheetWriteResult>;
}

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,parents,trashed,webViewLink,iconLink,size";

export function createGoogleClient(deps: {
  token: TokenProvider;
  fetchImpl?: typeof fetch;
}): GoogleDriveApi {
  const doFetch = deps.fetchImpl ?? ((input: string | URL | Request, init?: RequestInit) => retryFetch(input, init));

  async function call(url: string, init: RequestInit): Promise<Response> {
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const token = await deps.token.getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      try {
        return await doFetch(url, { ...init, headers });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === "AbortError";
        throw aborted ? errors.upstreamTimeout("google", cause) : errors.upstreamUnavailable("google", cause);
      }
    };
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true); // one forced refresh + retry
    return res;
  }

  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw mapGoogleError(res.status, body, retryAfter);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  function buildQ(folderId: string, kind?: string, q?: string): string {
    const clauses = [`'${folderId}' in parents`, "trashed = false"];
    if (kind) clauses.push(`mimeType = '${kind}'`);
    if (q) clauses.push(`name contains '${q.replace(/'/g, "\\'")}'`);
    return clauses.join(" and ");
  }

  return {
    async listFiles(p): Promise<{ files: GoogleFileResource[]; nextPageToken: string | null }> {
      const url = new URL(`${DRIVE_BASE}/files`);
      url.searchParams.set("q", buildQ(p.folderId, p.kind, p.q));
      url.searchParams.set("pageSize", String(p.pageSize));
      url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
      if (p.pageToken) url.searchParams.set("pageToken", p.pageToken);
      const res = await call(url.toString(), { method: "GET" });
      const data = await json<{ files?: GoogleFileResource[]; nextPageToken?: string }>(res);
      return { files: data.files ?? [], nextPageToken: data.nextPageToken ?? null };
    },
    async getFile(id): Promise<GoogleFileResource> {
      const url = `${DRIVE_BASE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`;
      return json<GoogleFileResource>(await call(url, { method: "GET" }));
    },
    async createFile(meta): Promise<GoogleFileResource> {
      const url = `${DRIVE_BASE}/files?fields=${encodeURIComponent(FILE_FIELDS)}`;
      const body: Record<string, unknown> = { name: meta.name, mimeType: meta.mimeType };
      if (meta.parentId) body.parents = [meta.parentId];
      return json<GoogleFileResource>(
        await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      );
    },
    async copyFile(templateId, meta): Promise<GoogleFileResource> {
      const url = `${DRIVE_BASE}/files/${encodeURIComponent(templateId)}/copy?fields=${encodeURIComponent(FILE_FIELDS)}`;
      const body: Record<string, unknown> = { name: meta.name };
      if (meta.parentId) body.parents = [meta.parentId];
      return json<GoogleFileResource>(
        await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      );
    },
    async moveFile(id, newParentId, oldParents): Promise<GoogleFileResource> {
      const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(id)}`);
      url.searchParams.set("addParents", newParentId);
      if (oldParents.length) url.searchParams.set("removeParents", oldParents.join(","));
      url.searchParams.set("fields", FILE_FIELDS);
      return json<GoogleFileResource>(
        await call(url.toString(), { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }),
      );
    },
    async trashFile(id): Promise<GoogleFileResource> {
      const url = `${DRIVE_BASE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`;
      return json<GoogleFileResource>(
        await call(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) }),
      );
    },
    async getSheetValues(spreadsheetId, range): Promise<SheetReadResult> {
      const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
      const data = await json<{ range?: string; values?: SheetReadResult["values"] }>(await call(url, { method: "GET" }));
      return { range: data.range ?? range, values: data.values ?? [] };
    },
    async updateSheetValues(spreadsheetId, range, values): Promise<SheetWriteResult> {
      const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
      const data = await json<{ updatedRange?: string; updatedRows?: number }>(
        await call(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ range, values }) }),
      );
      return { updatedRange: data.updatedRange ?? range, updatedRows: data.updatedRows ?? values.length };
    },
    async appendSheetValues(spreadsheetId, range, values): Promise<SheetWriteResult> {
      const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const data = await json<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
        await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ range, values }) }),
      );
      return { updatedRange: data.updates?.updatedRange ?? range, updatedRows: data.updates?.updatedRows ?? values.length };
    },
  };
}
