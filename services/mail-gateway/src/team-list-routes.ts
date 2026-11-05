// Team mailing list admin routes (mounted on the external /mail surface). Effective paths
// through api-gateway: /api/v1/mail/admin/lists. AUTHZ lives in src/policy-table.ts.
//
// The row is written BEFORE the Cloudflare rule and soft-deleted if the rule fails: a row with no
// rule is inert, while a rule with no row would take mail for the address and deliver it to
// nobody. Deleting runs the other way round for the same reason.
import type { Hono } from "hono";
import { DubError } from "@dub/errors";
import { nowIso, ulid } from "@dub/db";
import type { mail } from "@dub/types";
import { buildDb } from "./deps";
import type { AppBindings } from "./env";
import { CfEmailRoutingClient, requireEmailRoutingConfig, teamListRuleInput, type CfRoutingRule } from "./email-routing";
import { audited } from "./email-routing-routes";
import { parseTeamListRequest } from "./email-routing-validation";
import { lookupRosterUserId } from "./owner";
import { findActiveTeamList, toTeamListDto, type TeamListRow } from "./team-list";

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
      `SELECT id, address, team_id, cf_rule_id, created_at FROM mail_team_list WHERE deleted_at IS NULL ORDER BY address`,
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
    const rules = await client.listRules();
    if (rules.some((r) => ruleMatches(r, address))) throw conflict(address);
    if (await lookupRosterUserId(c.env.SVC_IDENTITY, ctx, address)) throw conflict(address);

    const now = nowIso();
    const row: TeamListRow = { id: `maillist_${ulid()}`, address, team_id: teamId, cf_rule_id: null, created_at: now };
    const inserted = await db.run(
      `INSERT OR IGNORE INTO mail_team_list (id, address, team_id, cf_rule_id, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
      row.id,
      address,
      teamId,
      ctx.userId ?? null,
      now,
      now,
    );
    if (inserted.meta.changes === 0) throw conflict(address);

    try {
      const rule = await audited(c, "mail.team_list.create", "mail_team_list", address, () =>
        client.createRule(teamListRuleInput(address, localPart, cfg.workerName)),
      );
      await db.run(`UPDATE mail_team_list SET cf_rule_id = ?, updated_at = ? WHERE id = ?`, rule.id, nowIso(), row.id);
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
      `SELECT id, address, team_id, cf_rule_id, created_at FROM mail_team_list WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
    if (!row) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `mailing list not found: ${id}`, { status: 404 });
    const client = new CfEmailRoutingClient(requireEmailRoutingConfig(c.env));
    await audited(c, "mail.team_list.delete", "mail_team_list", row.address, async () => {
      // A rule already removed by hand must not leave the row undeletable.
      const rules = await client.listRules();
      if (row.cf_rule_id && rules.some((r) => r.id === row.cf_rule_id)) await client.deleteRule(row.cf_rule_id);
    });
    const now = nowIso();
    await db.run(`UPDATE mail_team_list SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
    return c.json({ id }, 200);
  });
}
