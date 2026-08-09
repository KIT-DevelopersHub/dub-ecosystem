// DNS record routes (synchronous). Order is load-bearing:
//   authz -> allowed-zone gate (403, no audit) -> write-ahead intent (502 fail-close)
//   -> CF call -> local history + result audit + event.
import { Hono } from "hono";
import type { FieldError } from "@dub/errors";
import { errors, isDubError } from "@dub/errors";
import type { deploy } from "@dub/types";
import type { AppEnv } from "../http";
import {
  getDeps,
  reqCtx,
  requireAuth,
  requirePermission,
  readJson,
  requireString,
  assertValid,
} from "../http";

const VALID_TYPES: readonly deploy.CreateDnsRecordRequest["type"][] = ["A", "AAAA", "CNAME", "TXT"];

export function registerDnsRoutes(app: Hono<AppEnv>): void {
  app.post("/deploy/dns/records", requireAuth, requirePermission("infra:dns", true), async (c) => {
    const deps = getDeps(c);
    const body = await readJson(c);
    const fe: FieldError[] = [];
    const zone = requireString(body, "zone", fe);
    const type = requireString(body, "type", fe);
    const name = requireString(body, "name", fe);
    const content = requireString(body, "content", fe);
    if (type !== undefined && !VALID_TYPES.includes(type as deploy.CreateDnsRecordRequest["type"])) {
      fe.push({ field: "type", reason: "invalid" });
    }
    assertValid(fe);
    const recordType = type as deploy.CreateDnsRecordRequest["type"];

    // allowed-zone gate (physical barrier). Denied before any audit/CF (design §6).
    if (!(await deps.repo.isZoneAllowed(zone!))) {
      throw errors.forbidden(`zone not in allowed list: ${zone!}`, { zone: zone! });
    }

    const ctx = reqCtx(c);
    const intentId = await deps.audit.recordIntent(ctx, {
      action: "infra.dns.changed",
      actorId: ctx.userId ?? null,
      resourceType: "dns_record",
      resourceId: `${zone!}/${name!}`,
      details: { zone: zone!, op: "create", type: recordType, name: name! },
    });

    try {
      const record = await deps.cf.createDnsRecord({
        zone: zone!,
        type: recordType,
        name: name!,
        content: content!,
      });
      await deps.repo.recordDnsChange({
        zone: zone!,
        recordId: record.id,
        op: "create",
        recordType,
        recordName: name!,
        recordContent: content!,
        requestedBy: ctx.userId ?? "system",
        status: "applied",
        errorMessage: null,
      });
      await deps.events.dnsRecordChanged({ requestId: ctx.requestId, actorId: ctx.userId ?? null }, {
        zone: zone!,
        name: name!,
      });
      await deps.audit.recordResult(ctx, {
        action: "infra.dns.changed",
        actorId: ctx.userId ?? null,
        result: "success",
        resourceType: "dns_record",
        resourceId: record.id,
        intentId,
        details: { zone: zone!, name: name!, op: "create" },
      });
      return c.json({ id: record.id, zone: zone!, type: recordType, name: name!, content: content! }, 201);
    } catch (err) {
      await deps.repo.recordDnsChange({
        zone: zone!,
        recordId: null,
        op: "create",
        recordType,
        recordName: name!,
        recordContent: content!,
        requestedBy: ctx.userId ?? "system",
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "unknown",
      });
      await deps.audit.recordResult(ctx, {
        action: "infra.dns.changed",
        actorId: ctx.userId ?? null,
        result: "failure",
        resourceType: "dns_record",
        resourceId: `${zone!}/${name!}`,
        intentId,
        details: { zone: zone!, name: name!, op: "create" },
      });
      if (isDubError(err)) throw err;
      throw errors.upstreamUnavailable("cloudflare", err);
    }
  });
}
