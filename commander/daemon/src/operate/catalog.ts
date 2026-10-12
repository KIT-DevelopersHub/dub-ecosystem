// The operate console's allow-list. "Dubを操作" may ONLY call a route listed here: the
// executor looks every planned call up by catalog id and refuses anything else, so the
// planner can never reach a route nobody reviewed. Each entry mirrors a line of the owning
// service's policy-table.ts (test/operate-catalog.test.ts keeps the two in lock-step) and
// adds the operator-facing metadata the approval screen shows.
//
// Policy (the only user is the owner): every read in scope is open; a write is open unless
// it cannot be taken back, and such routes are left OUT of the catalog (listed with the
// reason in each area's `excluded`) rather than kept behind a high risk. The few
// irreversible effects the owner asked for explicitly are named in the area's
// `ownerOpenedIrreversible`.
// Bulk endpoints stay out: fan-out is one call per target, so every target is listed and
// verified.

import type { AreaSpec, CatalogEntry, ExcludedRoute } from "./catalog-types.ts";
import { CHAT } from "./areas/chat.ts";
import { COMMANDER } from "./areas/commander.ts";
import { DRIVE } from "./areas/drive.ts";
import { EVENT } from "./areas/event.ts";
import { GANTT } from "./areas/gantt.ts";
import { LP } from "./areas/lp.ts";
import { MEMBER } from "./areas/member.ts";
import { NOTIFICATION } from "./areas/notification.ts";
import { ROLE } from "./areas/role.ts";
import { TASK } from "./areas/task.ts";

export type * from "./catalog-types.ts";

export const API_PREFIX = "/api/v1";

export const AREAS: readonly AreaSpec[] = [EVENT, TASK, GANTT, NOTIFICATION, CHAT, MEMBER, ROLE, DRIVE, LP, COMMANDER];

export const CATALOG: readonly CatalogEntry[] = AREAS.flatMap((a) => a.entries);
export const EXCLUDED: readonly ExcludedRoute[] = AREAS.flatMap((a) => a.excluded);

/**
 * Routes the catalog must account for: per service, the path prefixes the gateway reaches
 * and that belong to an area above. Every non-internal route under them is either a catalog
 * entry, excluded with a reason, or pending — the catalog test fails on anything else, so a
 * route added to a service later cannot be silently missing from this decision.
 * Out of scope entirely: calendar, external mail (mail-gateway send/read, mail-automation)
 * and usage-meter.
 */
export const SCOPE: Readonly<Record<string, readonly string[]>> = {
  "event-service": ["/events", "/actions/"],
  "task-service": ["/tasks"],
  "gantt-service": ["/gantt"],
  notification: ["/notifications/", "/feedback"],
  "chat-service": ["/chat/"],
  "member-service": ["/members/"],
  "identity-roster": ["/identity/"],
  "mail-gateway": ["/mail/admin/email-routing/issued-addresses", "/mail/admin/email-routing/roster-addresses"],
  "drive-share-service": ["/driveshare/"],
  "drive-proxy": ["/drive/"],
  "file-meta": ["/files"],
  "lp-analytics": ["/lp/"],
  // Not behind the gateway: the local service, gated by its protection-table.ts.
  "commander-service": ["/features", "/tasks", "/runs", "/chats"],
};

/** Irreversible effects the owner opened on purpose (entry id -> why it is acceptable). */
export const OWNER_OPENED_IRREVERSIBLE: Readonly<Record<string, string>> = Object.assign(
  {},
  ...AREAS.map((a) => a.ownerOpenedIrreversible ?? {}),
);

export function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** Path param names in declaration order (":id" -> "id"). */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
}

/** The keys a bot role needs to reach every catalog entry, ロール管理 tiers included. */
export function requiredPermissionKeys(): string[] {
  return [
    ...new Set(
      CATALOG.flatMap((e) => [
        ...e.requires.keys,
        ...(e.requires.appLevel ? [`app:${e.requires.appLevel.app}:${e.requires.appLevel.level}`] : []),
      ]),
    ),
  ].sort();
}
