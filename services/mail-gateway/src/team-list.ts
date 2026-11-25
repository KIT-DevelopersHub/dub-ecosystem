// Team mailing lists (チームのメーリングリスト, migration 0024). A list address is an Email
// Routing rule to this Worker plus a mail_team_list row naming the team; when mail reaches
// it, each Dub account linked to the team's 運営メンバー gets a delivery row, so the mail sits
// in their inbox with its own read state. The list itself sends nothing back out, so it
// uses no provider quota.
//
// Reach is Dub inboxes only: personal auto-forward (user-forward.ts) stays envelope-scoped,
// and a member with no linked account receives nothing.
import type { DbClient } from "@dub/db";
import { createServiceClient } from "@dub/http";
import { consoleSink } from "@dub/observability";
import type { mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { isCompanyAddress } from "./from";
import { lookupRosterUserId } from "./owner";
import { insertListDeliveries } from "./repo";
import type { InboundDeps } from "./types";

export interface TeamListRow {
  id: string;
  address: string;
  team_id: string;
  created_at: string;
}

export const TEAM_LIST_COLUMNS = `id, address, team_id, created_at`;

/** @dub/db wraps every failure in DB_QUERY_FAILED: the D1 text is on the cause chain. */
function isMissingTable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof Error && /no such table/i.test(e.message)) return true;
  }
  return false;
}

/**
 * The live list at this address, or null. Every inbound mail passes through here and
 * migrations are applied out-of-band, so a missing table reads as "not a list". Any other
 * failure propagates: swallowing it would drop a real list's mail without a trace.
 */
export async function findActiveTeamList(db: DbClient, address: string): Promise<TeamListRow | null> {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return null;
  try {
    return (await db.first<TeamListRow>(`SELECT ${TEAM_LIST_COLUMNS} FROM mail_team_list WHERE address = ? AND deleted_at IS NULL`, normalized)) ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export function toTeamListDto(row: TeamListRow): mail.MailTeamList {
  return { id: row.id, address: row.address, localPart: row.address.split("@")[0] ?? row.address, teamId: row.team_id, createdAt: row.created_at };
}

/** The sender's own account, left out so a member's Cc to their team is not unread mail to
 *  themselves. A forged From only costs that member one copy of a mail they did not send. */
async function senderUserId(deps: InboundDeps, from: string): Promise<string | null> {
  return isCompanyAddress(from) ? lookupRosterUserId(deps.identity, deps.ctx, from) : null;
}

/** Give every member of the list's team a delivery of `message`. Throws when the team cannot
 *  be read: the mail is stored, but its only recipients have not got it. */
export async function deliverToTeam(deps: InboundDeps, list: TeamListRow, message: mail.MailMessage): Promise<void> {
  if (!deps.member) throw new Error("mail-gateway: SVC_MEMBER is not bound; cannot expand a team list");
  const client = createServiceClient(deps.member, { service: "member-service", caller: SERVICE_NAME });
  const { userIds } = await client.get<{ userIds: string[] }>(deps.ctx, `/members/internal/team-members?teamIds=${encodeURIComponent(list.team_id)}&excludeDeclined=1`);
  const sender = await senderUserId(deps, message.from.email);
  const recipients = userIds.filter((id) => id !== sender);
  await insertListDeliveries(deps.db, message.id, list.address, recipients);
  consoleSink({
    level: recipients.length === 0 ? "warn" : "info",
    message: "mail-gateway: team list delivered",
    service: SERVICE_NAME,
    requestId: deps.ctx.requestId,
    fields: { listId: list.id, inboundId: message.id, recipients: recipients.length },
  });
}
