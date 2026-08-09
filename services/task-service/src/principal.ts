// Caller principal resolution (theme6 frozen: entry verifies once, trusted headers
// propagate). A user principal comes from x-dub-user-id; a service principal from
// x-dub-internal + an allow-listed x-dub-caller with no user context.
import type { Context } from "hono";
import { DubError } from "@dub/errors";
import { HDR_INTERNAL, HDR_USER_ID, HDR_CALLER, INTERNAL_HEADER_VALUE } from "@dub/observability";

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "service"; caller: string };

export function resolvePrincipal(c: Context, serviceCallers: ReadonlySet<string>): Principal {
  const userId = c.req.header(HDR_USER_ID);
  const internal = c.req.header(HDR_INTERNAL) === INTERNAL_HEADER_VALUE;
  const caller = c.req.header(HDR_CALLER);
  if (internal && caller && serviceCallers.has(caller) && !userId) {
    return { kind: "service", caller };
  }
  if (userId) return { kind: "user", userId };
  throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent (no trusted principal)", { status: 401 });
}

export function isServiceRole(p: Principal): boolean {
  return p.kind === "service";
}

/** actorId contract (task-service.md §4): user=userId, service="service:<caller>". */
export function actorIdOf(p: Principal): string {
  return p.kind === "user" ? p.userId : `service:${p.caller}`;
}
