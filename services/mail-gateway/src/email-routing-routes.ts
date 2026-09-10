// Email Routing admin routes (mounted on the external /mail surface, gated mail:admin).
// Effective paths through api-gateway: /api/v1/mail/admin/email-routing/*.
//
//   GET    /admin/email-routing/addresses      list destination (forward-target) addresses
//   POST   /admin/email-routing/addresses      issue a destination address (CF sends a verify mail)
//   DELETE /admin/email-routing/addresses/:id   remove a destination address
//   GET    /admin/email-routing/rules          list forwarding rules
//   POST   /admin/email-routing/rules          create a rule (localpart matcher -> forward action)
//   PATCH  /admin/email-routing/rules/:id       update a rule (enable/disable, matchers, actions)
//   DELETE /admin/email-routing/rules/:id       delete a rule
//
// Every MUTATION is audited (publishAudit) with success/failure. Reads are not audited
// (mirrors the message read routes). When CF_EMAIL_ROUTING_TOKEN is unset, every route
// answers 503 MAIL_EMAIL_ROUTING_UNCONFIGURED via requireEmailRoutingConfig.
import type { Context, Hono, MiddlewareHandler } from "hono";
import { DubError } from "@dub/errors";
import { publishAudit } from "@dub/events";
import { nowIso } from "@dub/db";
import { consoleSink, HEADERS } from "@dub/observability";
import type { auditLog, identity, mail } from "@dub/types";
import { common } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { buildAuditEnv, buildSendDeps } from "./deps";
import type { AppBindings } from "./env";
import {
  CfEmailRoutingClient,
  issueReceivingRuleInput,
  issuedAddressesFromRules,
  issuedAddressFromRule,
  MAIL_WORKER_DESTINATION_LABEL,
  requireEmailRoutingConfig,
  rosterAddressesFromRules,
} from "./email-routing";
import {
  parseCreateAddressRequest,
  parseCreateRuleRequest,
  parseIssueAddressRequest,
  parseUpdateIssuedAddressRequest,
  parseUpdateRuleRequest,
} from "./email-routing-validation";
import { sendMail } from "./send";

type WithAuth = (permission: identity.PermissionKey) => MiddlewareHandler<AppBindings>;

/** Mount the Email Routing admin routes on the external app. */
export function registerEmailRoutingAdmin(ext: Hono<AppBindings>, withAuth: WithAuth): void {
  ext.use("/admin/email-routing/*", withAuth("mail:admin"));

  const clientOf = (c: { env: AppBindings["Bindings"] }) => new CfEmailRoutingClient(requireEmailRoutingConfig(c.env));

  // ---- destination addresses ----
  ext.get("/admin/email-routing/addresses", async (c) => {
    const items = await clientOf(c).listAddresses();
    return c.json({ items });
  });

  ext.post("/admin/email-routing/addresses", async (c) => {
    const { email } = parseCreateAddressRequest(await c.req.json().catch(() => null));
    const created = await audited(c, "mail.email_routing.address.create", "email_routing_address", email, () =>
      clientOf(c).createAddress(email),
    );
    return c.json(created, 201);
  });

  ext.delete("/admin/email-routing/addresses/:id", async (c) => {
    const id = c.req.param("id");
    const result = await audited(c, "mail.email_routing.address.delete", "email_routing_address", id, () =>
      clientOf(c).deleteAddress(id),
    );
    return c.json(result, 200);
  });

  // ---- roster sync source (derived from rules, zone-scoped) ----
  // The user roster syncs from the @developershub.jp RECEIVING addresses — the routing
  // rules people receive mail at — NOT the account-scoped destination (forward-target)
  // addresses (of which the domain has ~1). Returns one entry per issued receiving
  // address so identity-roster upserts a roster row for each. Fixes the sync that
  // previously read destination addresses and only ever added the single verified one.
  ext.get("/admin/email-routing/roster-addresses", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const rules = await new CfEmailRoutingClient(cfg).listRules();
    return c.json({ items: rosterAddressesFromRules(rules, cfg.zoneName) });
  });

  // ---- issued receiving addresses (@zone addresses people receive mail AT) ----
  // The roster console's メールアドレス管理 surface. Each issued address is a zone-scoped
  // routing rule that forwards `localPart@zone` to the mail Worker (this service's email()
  // handler → Dub inbox). This is the surface that actually makes an issued address WORK
  // (vs. the account-scoped /addresses destination surface above, which is a different
  // Cloudflare feature — a forward target, not a receiving rule). On issue we also send a
  // confirmation email to the new address so the admin can see it round-trip into Dub mail.
  ext.get("/admin/email-routing/issued-addresses", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const rules = await new CfEmailRoutingClient(cfg).listRules();
    return c.json({ items: issuedAddressesFromRules(rules, cfg.zoneName), nextCursor: null });
  });

  ext.post("/admin/email-routing/issued-addresses", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const { localPart, address } = parseIssueAddressRequest(await c.req.json().catch(() => null), cfg.zoneName);
    const client = new CfEmailRoutingClient(cfg);
    // Idempotency / abuse guard: never mint a second rule for an address already issued.
    const existing = await client.listRules();
    if (issuedAddressesFromRules(existing, cfg.zoneName).some((a) => a.address === address)) {
      throw new DubError("MAIL_EMAIL_ROUTING_CONFLICT", `address already issued: ${address}`, { status: 409 });
    }
    const rule = await audited(c, "mail.email_routing.address.issue", "email_routing_address", address, () =>
      client.createRule(issueReceivingRuleInput(address, localPart, cfg.workerName)),
    );
    const issued = issuedAddressFromRule(rule, cfg.zoneName) ?? {
      id: rule.id,
      localPart,
      address,
      destination: MAIL_WORKER_DESTINATION_LABEL,
      enabled: rule.enabled,
      createdAt: nowIso(),
    };
    // Confirmation mail is best-effort: the address is already issued, so a send hiccup
    // must never turn a successful issue into a 5xx. The outcome is surfaced as a flag.
    const confirmationEmailSent = await sendIssuanceConfirmation(c, address);
    return c.json({ ...issued, createdAt: issued.createdAt || nowIso(), confirmationEmailSent }, 201);
  });

  ext.patch("/admin/email-routing/issued-addresses/:id", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const id = c.req.param("id");
    const { enabled } = parseUpdateIssuedAddressRequest(await c.req.json().catch(() => null));
    const rule = await audited(c, "mail.email_routing.address.update", "email_routing_address", id, () =>
      new CfEmailRoutingClient(cfg).updateRule(id, { enabled }),
    );
    return c.json(issuedAddressFromRule(rule, cfg.zoneName) ?? { id, enabled }, 200);
  });

  ext.delete("/admin/email-routing/issued-addresses/:id", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const id = c.req.param("id");
    const result = await audited(c, "mail.email_routing.address.revoke", "email_routing_address", id, () =>
      new CfEmailRoutingClient(cfg).deleteRule(id),
    );
    return c.json({ id: result.id }, 200);
  });

  // ---- routing rules ----
  ext.get("/admin/email-routing/rules", async (c) => {
    const items = await clientOf(c).listRules();
    return c.json({ items });
  });

  ext.post("/admin/email-routing/rules", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const input = parseCreateRuleRequest(await c.req.json().catch(() => null), cfg.zoneName);
    const created = await audited(c, "mail.email_routing.rule.create", "email_routing_rule", input.name, () =>
      new CfEmailRoutingClient(cfg).createRule(input),
    );
    return c.json(created, 201);
  });

  ext.patch("/admin/email-routing/rules/:id", async (c) => {
    const cfg = requireEmailRoutingConfig(c.env);
    const id = c.req.param("id");
    const patch = parseUpdateRuleRequest(await c.req.json().catch(() => null), cfg.zoneName);
    const updated = await audited(c, "mail.email_routing.rule.update", "email_routing_rule", id, () =>
      new CfEmailRoutingClient(cfg).updateRule(id, patch),
    );
    return c.json(updated, 200);
  });

  ext.delete("/admin/email-routing/rules/:id", async (c) => {
    const id = c.req.param("id");
    const result = await audited(c, "mail.email_routing.rule.delete", "email_routing_rule", id, () =>
      clientOf(c).deleteRule(id),
    );
    return c.json(result, 200);
  });
}

/**
 * Run a mutating CF call, emitting a success/failure audit record either way. The audit
 * publish never masks the real outcome: a publish error is logged, not thrown, and the
 * CF result / error propagates unchanged.
 */
async function audited<T>(
  c: Context<AppBindings>,
  action: string,
  resourceType: string,
  resourceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = c.get("dubCtx");
  const actorId = ctx.userId ?? c.req.header(HEADERS.userId) ?? null;
  try {
    const result = await fn();
    await emitAudit(c.env, { action, actorId, resourceType, resourceId, result: "success", requestId: ctx.requestId, errorCode: null });
    return result;
  } catch (err) {
    const errorCode = (err as { code?: string } | null)?.code ?? "MAIL_EMAIL_ROUTING_UPSTREAM";
    await emitAudit(c.env, { action, actorId, resourceType, resourceId, result: "failure", requestId: ctx.requestId, errorCode });
    throw err;
  }
}

/**
 * Send the "address issued" confirmation to the freshly-issued address. It goes out from
 * the system default (info@developershub.jp) via the configured provider (Resend); because
 * the issued address now routes to the mail Worker, the message round-trips back INTO Dub's
 * inbox — the admin sees it arrive, proving the issue actually works end-to-end.
 *
 * Best-effort by contract: a provider failure is logged and reported as `false`, never
 * thrown, so a send outage cannot fail an already-successful issue. Idempotency-keyed on
 * the address so a retried issue does not double-send. Loop headers mark it auto-generated
 * so mail-automation does not treat it as a message to auto-reply to.
 */
async function sendIssuanceConfirmation(c: Context<AppBindings>, address: string): Promise<boolean> {
  const ctx = c.get("dubCtx");
  const req: mail.SendMailRequest = {
    to: [{ email: address }],
    subject: "メールアドレスを発行しました",
    textBody:
      `${address} を発行しました。\n\n` +
      "これは、DevelopersHub 管理コンソールでこのメールアドレスが発行されたことをお知らせする確認メールです。" +
      "今後このアドレス宛に届いたメールは、Dub のメール受信トレイで確認できます。\n\n" +
      "— DevelopersHub",
    loopHeaders: { "auto-submitted": "auto-generated", "x-dub-mail-loop": "email-routing-issue-confirm" },
  };
  try {
    const deps = buildSendDeps(c.env, ctx);
    const { status } = await sendMail(deps, req, `email-routing-issue:${address}`, ctx.userId ?? "email-routing-admin");
    return status === "sent" || status === "duplicate";
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: issued-address confirmation email failed",
      service: SERVICE_NAME,
      requestId: ctx.requestId,
      fields: { address, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

async function emitAudit(
  env: AppBindings["Bindings"],
  a: { action: string; actorId: string | null; resourceType: string; resourceId: string; result: "success" | "failure"; requestId: string; errorCode: string | null },
): Promise<void> {
  const input: auditLog.AuditRecordInput = {
    action: a.action,
    actorId: a.actorId,
    orgId: common.DUB_DEFAULT_ORG_ID,
    result: a.result,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    details: a.errorCode ? { errorCode: a.errorCode } : null,
    requestId: a.requestId,
    occurredAt: nowIso(),
  };
  try {
    await publishAudit(buildAuditEnv(env), input);
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: failed to publish email-routing audit",
      service: SERVICE_NAME,
      requestId: a.requestId,
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
