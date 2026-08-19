// Realtime wiring for gantt-service: (1) issue the short-lived ws-ticket the browser
// presents to the GanttRoom DO (gateway-bypassing / DO-direct, mirrors chat theme11),
// and (2) a best-effort server-side change broadcast used by the event-consumer path so
// data changed OUTSIDE a room's own sockets (via the event pipeline) still reaches
// connected clients. The DO stays the single fanout point; the DB stays source of truth.
import { createServiceClient, type RequestContext } from "@dub/http";
import { gantt, type common, type identity } from "@dub/types";
import type { Env } from "./env";
import { SERVICE_NAME } from "./env";
import { signWsTicket, ticketExpiryMs } from "./wsticket";

// Dev-only fallback secret; production sets WS_TICKET_SECRET via wrangler secret. MUST
// match the GanttRoom DO fallback (gantt-room-do.ts) and the dev issuer (index.ts).
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";
const DEFAULT_DO_URL_BASE = "wss://dub-gantt-service.developershub-site.workers.dev/ws/:id";

export function ganttWsSecret(env: Env): string {
  return env.WS_TICKET_SECRET ?? DEV_WS_SECRET;
}

/** Build the absolute DO URL for an event room from the configured base (":id" slot). */
export function ganttDoUrl(env: Env, eventId: common.EventId): string {
  const base = env.GANTT_RT_DO_URL_BASE ?? DEFAULT_DO_URL_BASE;
  return base.replace(":id", encodeURIComponent(eventId));
}

/** Best-effort display-name resolve for the presence label. A failure is non-fatal —
 *  the ticket omits displayName and the client falls back to its own roster / initials. */
async function resolveDisplayName(env: Env, ctx: RequestContext, userId: common.UserId): Promise<string | undefined> {
  if (!env.SVC_IDENTITY) return undefined;
  try {
    const client = createServiceClient(env.SVC_IDENTITY, { service: "identity-roster", caller: SERVICE_NAME });
    const res = await client.get<common.Paginated<identity.UserSummary>>(ctx, "/identity/users", {
      query: { ids: userId },
    });
    return res.items.find((u) => u.id === userId)?.displayName;
  } catch {
    return undefined;
  }
}

/** Issue a ws-ticket for (userId, eventId). The userId comes from the verified session
 *  (trusted header), never the client — the DO then trusts the SIGNED identity on /ws. */
export async function issueWsTicket(
  env: Env,
  ctx: RequestContext,
  userId: common.UserId,
  eventId: common.EventId,
): Promise<gantt.WsTicketResponse> {
  const displayName = await resolveDisplayName(env, ctx, userId);
  const exp = ticketExpiryMs();
  const ticket = await signWsTicket(ganttWsSecret(env), {
    eventId,
    userId,
    ...(displayName ? { displayName } : {}),
    expEpochMs: exp,
  });
  return {
    ticket,
    doUrl: ganttDoUrl(env, eventId),
    expiresAt: new Date(exp).toISOString() as common.ISODateTime,
    self: { userId, ...(displayName ? { displayName } : {}) },
  };
}

/** Best-effort fanout of a data change to a room's sockets (server-authored path). Never
 *  throws — a realtime hiccup must not fail the HTTP write that triggered it. */
export async function broadcastGanttChange(
  env: Env,
  eventId: common.EventId,
  change: gantt.GanttChangeKind | string,
  actorId: common.UserId,
  taskId?: common.TaskId | null,
): Promise<void> {
  if (!env.GANTT_ROOM) return;
  try {
    const stub = env.GANTT_ROOM.getByName(eventId);
    await stub.broadcastChange(change, actorId, taskId ?? null);
  } catch {
    /* realtime is best-effort; the next client refetch / poll converges */
  }
}
