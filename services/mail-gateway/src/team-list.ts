// Team mailing lists (チームのメーリングリスト, migration 0024). A list address is an Email
// Routing rule to this Worker plus a mail_team_list row naming the team; when mail reaches
// it, each Dub account linked to the team's 運営メンバー gets a delivery row, so the mail sits
// in their inbox with its own read state. Nothing is sent back out, so a list uses no
// provider quota and cannot loop.
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
  cf_rule_id: string | null;
  created_at: string;
}

const LIVE_COLUMNS = `id, address, team_id, cf_rule_id, created_at`;

/**
 * The live list at this address, or null. Every inbound mail passes through here, so a
 * failure (including migration 0024 not being applied yet) must not cost it its ordinary
 * delivery: it is logged and read as "not a list". Migrations are applied out-of-band.
 */
export async function findActiveTeamList(db: DbClient, address: string): Promise<TeamListRow | null> {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return null;
  try {
    return (await db.first<TeamListRow>(`SELECT ${LIVE_COLUMNS} FROM mail_team_list WHERE address = ? AND deleted_at IS NULL`, normalized)) ?? null;
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: team list lookup failed",
      service: SERVICE_NAME,
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
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
  const { userIds } = await client.get<{ userIds: string[] }>(deps.ctx, `/members/internal/team-members?teamIds=${encodeURIComponent(list.team_id)}`);
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
