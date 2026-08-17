// REAL Google Drive v3 client — the ONLY place raw Google Drive calls live for this
// service. Uses raw fetch (no google SDK). Every non-2xx is converted via mapGoogleError
// so no raw Google error leaks. A 401 triggers exactly one forced token refresh + retry.
// `fetchImpl` is injectable so tests never hit the network.
import { errors } from "@dub/errors";
import { retryFetch } from "@dub/http";
import type {
  CreatePermissionParams,
  DriveShareClient,
  ListFilesParams,
} from "../drive-client";
import { mapFile, mapGoogleError, mapPermission } from "../drive-client";
import type { ListFilesResult, ListPermissionsResult, SharePermission, ShareRole } from "../types";
import type { TokenProvider } from "./token";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
// list() projection: owner + link-share hint (permissions type) computed in mapFile.
const LIST_FIELDS = "nextPageToken,files(id,name,mimeType,owners(displayName),modifiedTime,webViewLink,permissions(id,type))";
// permissionDetails.inherited tells us whether a grant comes from an ancestor folder /
// shared drive (→ not deletable/editable on this item); the manager needs it to disable
// the revoke/role controls instead of letting Drive reject the call with 403.
const PERMISSION_FIELDS = "id,type,role,emailAddress,displayName,domain,permissionDetails(inherited)";

interface GoogleListResponse {
  files?: Parameters<typeof mapFile>[0][];
  nextPageToken?: string;
}
interface GooglePermissionsListResponse {
  permissions?: Parameters<typeof mapPermission>[0][];
}

export function createGoogleDriveShareClient(deps: {
  token: TokenProvider;
  fetchImpl?: typeof fetch;
}): DriveShareClient {
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

  async function readJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw mapGoogleError(res.status, body, retryAfter);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  async function expectOkOr404(res: Response): Promise<void> {
    // DELETE returns 204; a 404 means the permission is already gone → idempotent.
    if (res.ok || res.status === 404) return;
    const body = await res.json().catch(() => null);
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    throw mapGoogleError(res.status, body, retryAfter);
  }

  function buildQ(folderId?: string, q?: string): string {
    const clauses = ["trashed = false"];
    if (folderId) clauses.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
    if (q) clauses.push(`name contains '${q.replace(/'/g, "\\'")}'`);
    return clauses.join(" and ");
  }

  return {
    async listFiles(p: ListFilesParams): Promise<ListFilesResult> {
      const url = new URL(`${DRIVE_BASE}/files`);
      url.searchParams.set("q", buildQ(p.folderId, p.q));
      url.searchParams.set("pageSize", String(p.pageSize));
      url.searchParams.set("orderBy", "folder,name");
      url.searchParams.set("fields", LIST_FIELDS);
      // Include items owned by others / on shared drives, and let the call operate on
      // shared-drive resources. Harmless for My Drive; required if the Hackit tree ever
      // moves to (or links) a shared drive.
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("corpora", "allDrives");
      if (p.pageToken) url.searchParams.set("pageToken", p.pageToken);
      const data = await readJson<GoogleListResponse>(await call(url.toString(), { method: "GET" }));
      return { files: (data.files ?? []).map(mapFile), nextCursor: data.nextPageToken ?? null };
    },

    async listPermissions(fileId: string): Promise<ListPermissionsResult> {
      const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`);
      url.searchParams.set("fields", `permissions(${PERMISSION_FIELDS})`);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("supportsAllDrives", "true");
      const data = await readJson<GooglePermissionsListResponse>(await call(url.toString(), { method: "GET" }));
      return { fileId, permissions: (data.permissions ?? []).map(mapPermission) };
    },

    async createPermission(fileId: string, p: CreatePermissionParams): Promise<SharePermission> {
      const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`);
      url.searchParams.set("fields", PERMISSION_FIELDS);
      url.searchParams.set("supportsAllDrives", "true");
      // Never email-blast the grantee on every change; the manager is the UI of record.
      url.searchParams.set("sendNotificationEmail", "false");
      const body: Record<string, unknown> = { role: p.role, type: p.type };
      if (p.emailAddress) body.emailAddress = p.emailAddress;
      const res = await call(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return mapPermission(await readJson(res));
    },

    async updatePermission(fileId: string, permissionId: string, role: ShareRole): Promise<SharePermission> {
      const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`);
      url.searchParams.set("fields", PERMISSION_FIELDS);
      url.searchParams.set("supportsAllDrives", "true");
      const res = await call(url.toString(), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      return mapPermission(await readJson(res));
    },

    async deletePermission(fileId: string, permissionId: string): Promise<void> {
      const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`);
      url.searchParams.set("supportsAllDrives", "true");
      await expectOkOr404(await call(url.toString(), { method: "DELETE" }));
    },
  };
}
