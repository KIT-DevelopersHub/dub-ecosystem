// 名簿のチーム・役職 -> identity-roster の自動ロール。
//
// 何を付けるか (desiredManagedRoles) はここで決め、付け外しの実体は identity-roster の
// PUT /internal/managed-roles・PUT /internal/users/:id/managed-roles が行う (source =
// auto:member-sync の割当だけを足し引きし、手動の割当には触らない)。
import type { Fetcher } from "@cloudflare/workers-types";
import { DUB_HEADERS, INTERNAL_MARKER } from "@dub/http";
import { DubError, errors } from "@dub/errors";
import { member, type identity } from "@dub/types";
import type { PersonRow, TeamRow } from "./types";

export interface RoleSyncCtx {
  requestId: string;
  userId: string;
}

/** identity-roster の自動ロール API (index.ts で SVC_IDENTITY に結線・テストでは fake)。 */
export interface RoleSyncPort {
  syncCatalog(ctx: RoleSyncCtx, req: identity.PutManagedRoleCatalogRequest): Promise<identity.PutManagedRoleCatalogResponse>;
  syncUser(ctx: RoleSyncCtx, identityUserId: string, req: identity.PutUserManagedRolesRequest): Promise<identity.PutUserManagedRolesResponse>;
}

/** 自動ロールの一覧そのもの: 役職 3 つ + チームごと 1 つ。 */
export function managedRoleCatalog(teams: readonly TeamRow[]): identity.ManagedRoleSpec[] {
  return [
    ...member.MEMBER_POSITIONS.map((p) => ({ id: member.positionRoleId(p), name: member.positionRoleName(p) })),
    ...teams.map((t) => ({ id: member.teamRoleId(t.id), name: member.teamRoleName(t.name) })),
  ];
}

/** その人に付くべき自動ロール。在籍中 (added) でアカウントに紐付いた人だけ。役職は 1 つ、
 *  チームは所属する全部。役職が未設定なら役職ロールは付けない。 */
export function desiredManagedRoles(
  person: PersonRow | null,
  teamIds: readonly string[],
  teamsById: ReadonlyMap<string, TeamRow>,
): identity.ManagedRoleSpec[] {
  if (!person || person.archivedAt || person.status !== "added" || !person.identityUserId) return [];
  const out: identity.ManagedRoleSpec[] = [];
  if (person.position) out.push({ id: member.positionRoleId(person.position), name: member.positionRoleName(person.position) });
  for (const id of teamIds) {
    const t = teamsById.get(id);
    if (t) out.push({ id: member.teamRoleId(t.id), name: member.teamRoleName(t.name) });
  }
  return out;
}

/** SVC_IDENTITY 経由の実装。x-dub-user-id は操作した管理者 (割当の granted_by になる)。 */
export function createIdentityRoleSync(binding: Fetcher): RoleSyncPort {
  async function put<T>(ctx: RoleSyncCtx, path: string, body: unknown): Promise<T> {
    const res = await (binding as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      new Request(`https://svc${path}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [DUB_HEADERS.requestId]: ctx.requestId,
          [DUB_HEADERS.caller]: "member-service",
          [DUB_HEADERS.internal]: INTERNAL_MARKER,
          [DUB_HEADERS.userId]: ctx.userId,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      throw new DubError("MEMBER_ROLE_SYNC_FAILED", `identity ${path} -> ${res.status}`, { status: 502 });
    }
    return (await res.json()) as T;
  }
  return {
    syncCatalog: (ctx, req) => put(ctx, "/internal/managed-roles", req),
    syncUser: (ctx, uid, req) => put(ctx, `/internal/users/${encodeURIComponent(uid)}/managed-roles`, req),
  };
}

export const errRoleSyncUnavailable = (): DubError => errors.upstreamUnavailable("identity-roster (role sync)");

/** best-effort 失敗のログ (名簿の保存は成功させ、ずれは一括付与で直す)。 */
export function warnRoleSync(ctx: RoleSyncCtx, what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "member-service",
      msg: `role sync failed (best-effort; roster saved): ${what}`,
      requestId: ctx.requestId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
