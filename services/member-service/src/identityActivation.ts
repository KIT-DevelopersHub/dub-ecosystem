// 名簿で在籍 (added) かつアカウントに紐付いた人 -> identity の招待中アカウントを有効化。
//
// identity の invite は status = invited で作るが、Web のログイン (password) は active しか
// 通さない。Web の Google ログイン (初回で invited -> active にしていた) が無くなったので、
// 「名簿で在籍が確定した」ことを有効化の合図にする。実体は identity-roster の
// POST /internal/users/:id/activate (invited だけを active にする・停止中には触れない)。
import type { Fetcher } from "@cloudflare/workers-types";
import { DUB_HEADERS, INTERNAL_MARKER } from "@dub/http";
import { DubError } from "@dub/errors";
import type { identity } from "@dub/types";
import type { PersonRow } from "./types";

export interface ActivationCtx {
  requestId: string;
  userId: string;
}

/** どの経路で在籍・紐付けが確定したか (identity の監査に残る)。 */
export type ActivationTrigger =
  | "member.link"
  | "member.update"
  | "participation.link"
  | "hr.join"
  | "member.backfill";

/** identity-roster の有効化 API (index.ts で SVC_IDENTITY に結線・テストでは fake)。 */
export interface IdentityActivationPort {
  activate(ctx: ActivationCtx, identityUserId: string, req: identity.ActivateInvitedUserRequest): Promise<identity.ActivateInvitedUserResponse>;
}

/** 有効化してよい名簿行か: 在籍 (added)・アーカイブされていない・アカウントに紐付いている。 */
export function shouldActivate(person: PersonRow | null): person is PersonRow & { identityUserId: string } {
  return !!person && !person.archivedAt && person.status === "added" && !!person.identityUserId;
}

/** SVC_IDENTITY 経由の実装。x-dub-user-id は操作した管理者 (監査の actor になる)。 */
export function createIdentityActivation(binding: Fetcher): IdentityActivationPort {
  return {
    async activate(ctx, uid, req) {
      const path = `/internal/users/${encodeURIComponent(uid)}/activate`;
      const res = await (binding as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
        new Request(`https://svc${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [DUB_HEADERS.requestId]: ctx.requestId,
            [DUB_HEADERS.caller]: "member-service",
            [DUB_HEADERS.internal]: INTERNAL_MARKER,
            [DUB_HEADERS.userId]: ctx.userId,
          },
          body: JSON.stringify(req),
        }),
      );
      if (!res.ok) {
        throw new DubError("MEMBER_IDENTITY_ACTIVATION_FAILED", `identity ${path} -> ${res.status}`, { status: 502 });
      }
      return (await res.json()) as identity.ActivateInvitedUserResponse;
    },
  };
}

/** best-effort 失敗のログ (名簿の保存は成功させ、次の保存か一括付与で再試行される)。 */
export function warnActivation(ctx: ActivationCtx, identityUserId: string, trigger: ActivationTrigger, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "member-service",
      msg: "identity activation failed (best-effort; roster saved)",
      requestId: ctx.requestId,
      identityUserId,
      trigger,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
