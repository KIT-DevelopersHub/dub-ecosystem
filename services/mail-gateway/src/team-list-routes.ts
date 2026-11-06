// Team mailing list admin routes (mounted on the external /mail surface). Effective paths
// through api-gateway: /api/v1/mail/admin/lists. AUTHZ lives in src/policy-table.ts.
//
// The row is written BEFORE the Cloudflare rule and soft-deleted if the rule fails: a row with no
// rule is inert, while a rule with no row would take mail for the address and deliver it to
// nobody. Deleting runs the other way round for the same reason. A rule left behind anyway
// (a timed-out create that did land) is `dub-list:` with no live row, and creating the list
// again clears it.
import type { Hono } from "hono";
import { DubError } from "@dub/errors";
import { nowIso, ulid } from "@dub/db";
import type { mail } from "@dub/types";
import { buildDb } from "./deps";
import type { AppBindings } from "./env";
import { CfEmailRoutingClient, isTeamListRule, requireEmailRoutingConfig, teamListRuleInput, type CfRoutingRule } from "./email-routing";
import { audited } from "./email-routing-routes";
import { DEFAULT_ARCHIVE_CC_ADDRESS, DEFAULT_FROM_ADDRESS } from "./config";
import { parseTeamListRequest } from "./email-routing-validation";
import { lookupRosterUserId } from "./owner";
import { findActiveTeamList, TEAM_LIST_COLUMNS, toTeamListDto, type TeamListRow } from "./team-list";

function conflict(address: string): DubError {
  return new DubError("MAIL_EMAIL_ROUTING_CONFLICT", `address already in use: ${address}`, { status: 409 });
}

function ruleMatches(rule: CfRoutingRule, address: string): boolean {
  return (rule.matchers ?? []).some((m) => m.value?.trim().toLowerCase() === address);
}

export function registerTeamListAdmin(ext: Hono<AppBindings>): void {
  ext.get("/admin/lists", async (c) => {
    const db = buildDb(c.env, c.get("dubCtx").requestId);
    const rows = await db.all<TeamListRow>(
      `SELECT ${TEAM_LIST_COLUMNS} FROM mail_team_list WHERE deleted_at IS NULL ORDER BY address`,
    );
    return c.json({ items: rows.map(toTeamListDto) });
  });

  ext.post("/admin/lists", async (c) => {
    const ctx = c.get("dubCtx");
    const cfg = requireEmailRoutingConfig(c.env);
    const { localPart, address, teamId } = parseTeamListRequest(await c.req.json().catch(() => null), cfg.zoneName);
    const db = buildDb(c.env, ctx.requestId);
    const client = new CfEmailRoutingClient(cfg);

    // A person's address, an issued address or another list must keep working as it does.
    // archive@ and info@ are named outright: a list there would hand them to a team.
    const reserved = [c.env.MAIL_ARCHIVE_CC ?? DEFAULT_ARCHIVE_CC_ADDRESS, c.env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS];
    if (reserved.some((a) => a.trim().toLowerCase() === address)) throw conflict(address);
    const rules = (await client.listRules()).filter((r) => ruleMatches(r, address));
    if (rules.some((r) => !isTeamListRule(r))) throw conflict(address);
    if (await findActiveTeamList(db, address)) throw conflict(address);
    if (await lookupRosterUserId(c.env.SVC_IDENTITY, ctx, address)) throw conflict(address);

    const now = nowIso();
    const row: TeamListRow = { id: `maillist_${ulid()}`, address, team_id: teamId, created_at: now };
    const inserted = await db.run(
      `INSERT OR IGNORE INTO mail_team_list (id, address, team_id, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      row.id,
      address,
      teamId,
      ctx.userId ?? null,
      now,
      now,
    );
    if (inserted.meta.changes === 0) throw conflict(address);

    try {
      await audited(c, "mail.team_list.create", "mail_team_list", address, async () => {
        for (const orphan of rules) await client.deleteRule(orphan.id);
        return client.createRule(teamListRuleInput(address, localPart, cfg.workerName));
      });
    } catch (err) {
      const failedAt = nowIso();
      await db.run(`UPDATE mail_team_list SET deleted_at = ?, updated_at = ? WHERE id = ?`, failedAt, failedAt, row.id);
      throw err;
    }
    const dto: mail.MailTeamList = toTeamListDto(row);
    return c.json(dto, 201);
  });

  ext.delete("/admin/lists/:id", async (c) => {
    const id = c.req.param("id");
    const db = buildDb(c.env, c.get("dubCtx").requestId);
    const row = await db.first<TeamListRow>(
      `SELECT ${TEAM_LIST_COLUMNS} FROM mail_team_list WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
    if (!row) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `mailing list not found: ${id}`, { status: 404 });
    const client = new CfEmailRoutingClient(requireEmailRoutingConfig(c.env));
    await audited(c, "mail.team_list.delete", "mail_team_list", row.address, async () => {
      // By address, so a rule already removed by hand cannot leave the row undeletable.
      const rules = await client.listRules();
      for (const rule of rules.filter((r) => isTeamListRule(r) && ruleMatches(r, row.address))) await client.deleteRule(rule.id);
    });
    const now = nowIso();
    await db.run(`UPDATE mail_team_list SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
    return c.json({ id }, 200);
  });
}
