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
// Root listing also needs `parents` to drop shared items nested under another root item.
const ROOT_FIELDS = "nextPageToken,files(id,name,mimeType,owners(displayName),modifiedTime,webViewLink,permissions(id,type),parents)";
// Upper bound per root query (Workers subrequest budget); Drive caps each page itself.
const ROOT_MAX_PAGES = 5;
// permissionDetails.inherited tells us whether a grant comes from an ancestor folder /
// shared drive (→ not deletable/editable on this item); the manager needs it to disable
// the revoke/role controls instead of letting Drive reject the call with 403.
const PERMISSION_FIELDS = "id,type,role,emailAddress,displayName,domain,permissionDetails(inherited)";

/** First Google error `reason` (e.g. "invalidSharingRequest"), or undefined. */
function extractReason(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: { errors?: { reason?: string }[] } }).error;
    return e?.errors?.[0]?.reason;
  }
  return undefined;
}

type GoogleFile = Parameters<typeof mapFile>[0] & { parents?: string[] };
interface GoogleListResponse {
  files?: GoogleFile[];
  nextPageToken?: string;
}
interface GoogleDrivesListResponse {
  drives?: { id: string }[];
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
      throw mapGoogleError(res.status, body);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  async function expectOkOr404(res: Response): Promise<void> {
    // DELETE returns 204; a 404 means the permission is already gone → idempotent.
    if (res.ok || res.status === 404) return;
    const body = await res.json().catch(() => null);
    throw mapGoogleError(res.status, body);
  }

  function buildQ(folderId?: string, q?: string): string {
    const clauses = ["trashed = false"];
    if (folderId) clauses.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
    if (q) clauses.push(`name contains '${q.replace(/'/g, "\\'")}'`);
    return clauses.join(" and ");
  }

  async function listPage(q: string, pageSize: number, fields: string, pageToken?: string): Promise<GoogleListResponse> {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("orderBy", "folder,name");
    url.searchParams.set("fields", fields);
    // Include items owned by others / on shared drives, and let the call operate on
    // shared-drive resources. Harmless for My Drive; required if the Hackit tree ever
    // moves to (or links) a shared drive.
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("corpora", "allDrives");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return readJson<GoogleListResponse>(await call(url.toString(), { method: "GET" }));
  }

  async function listAll(q: string): Promise<GoogleFile[]> {
    const all: GoogleFile[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < ROOT_MAX_PAGES; i++) {
      const data = await listPage(q, 1000, ROOT_FIELDS, pageToken);
      all.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return all;
  }

  async function listSharedDriveIds(): Promise<string[]> {
    const url = new URL(`${DRIVE_BASE}/drives`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "drives(id)");
    const data = await readJson<GoogleDrivesListResponse>(await call(url.toString(), { method: "GET" }));
    return (data.drives ?? []).map((d) => d.id);
  }

  // The tree's top level: My Drive root children, shared-with-me tops and shared-drive
  // tops — queried directly instead of scanning the whole account. A shared-with-me item
  // whose parent is also in the result is nested, so it is dropped here.
  async function listRoots(): Promise<ListFilesResult> {
    const [mine, driveIds] = await Promise.all([
      listAll("trashed = false and ('root' in parents or sharedWithMe = true)"),
      listSharedDriveIds(),
    ]);
    const driveTops = await Promise.all(driveIds.map((id) => listAll(buildQ(id))));
    const all = [...mine, ...driveTops.flat()];
    const visible = new Set(all.map((f) => f.id));
    const roots = all
      .filter((f) => !(f.parents ?? []).some((id) => visible.has(id)))
      .map(mapFile)
      .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
    return { files: roots, nextCursor: null };
  }

  return {
    async listFiles(p: ListFilesParams): Promise<ListFilesResult> {
      if (!p.folderId && !p.q) return listRoots();
      const data = await listPage(buildQ(p.folderId, p.q), p.pageSize, LIST_FIELDS, p.pageToken);
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
      const body: Record<string, unknown> = { role: p.role, type: p.type };
      if (p.emailAddress) body.emailAddress = p.emailAddress;

      // Grantees WITHOUT a Google account (school / Cloudflare-routing addresses, etc.)
      // can only be added WITH a notification email — Drive rejects sendNotificationEmail=false
      // for them with 400 `invalidSharingRequest`. So we try silent first (no email-blast for
      // the common Google-account case), and only if Drive refuses with that specific reason do
      // we retry once WITH a notification (a one-time invite). anyone/domain never hit this.
      const post = (notify: boolean): Promise<Response> => {
        const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`);
        url.searchParams.set("fields", PERMISSION_FIELDS);
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("sendNotificationEmail", String(notify));
        return call(url.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      };

      let res = await post(false);
      let invited = false;
      if (res.status === 400 && p.emailAddress && (p.type === "user" || p.type === "group")) {
        const peeked = await res.clone().json().catch(() => null);
        if (extractReason(peeked) === "invalidSharingRequest") {
          // No Google account for this address → only shareable with an invite. The
          // resulting permission is pending until the address gets a Google account.
          res = await post(true);
          invited = true;
        }
      }
      const perm = mapPermission(await readJson(res));
      return invited ? { ...perm, invited: true } : perm;
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
