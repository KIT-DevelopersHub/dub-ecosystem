// Routing table (config-driven, frozen semantics). External paths are all under
// API_PREFIX; strip semantics are fixed to "remove API_PREFIX only" (not configurable).
// Internal-only sub-paths are 404'd here (double-defense: receiver also checks x-dub-internal).
import { common } from "@dub/types";

export type RouteAuth = "public" | "required";

export interface GatewayRoute {
  /** first path segment after API_PREFIX, e.g. "tasks" */
  segment: string;
  /** target Service Binding name (infra registry owns the union) */
  binding: string;
  auth: RouteAuth;
  /** post-strip internal paths that must 404 externally. Entries ending in "/" are prefix matches. */
  internalOnlyPaths?: string[];
  /** override request body cap for this route (bytes) */
  maxBodyBytes?: number;
}

export const API_PREFIX = common.API_PREFIX; // "/api/v1"

// Paths the gateway handles itself (never proxied). Registered before the catch-all.
export const GATEWAY_OWNED_SEGMENTS = new Set(["me", "bff", "public"]);

export const ROUTES: readonly GatewayRoute[] = [
  { segment: "auth", binding: "SVC_AUTH", auth: "public" },
  {
    segment: "identity",
    binding: "SVC_IDENTITY",
    auth: "required",
    internalOnlyPaths: ["/identity/users/provision", "/identity/authz/check", "/identity/internal/"],
  },
  { segment: "events", binding: "SVC_EVENT", auth: "required" },
  { segment: "actions", binding: "SVC_EVENT", auth: "required" },
  { segment: "tasks", binding: "SVC_TASK", auth: "required" },
  { segment: "gantt", binding: "SVC_GANTT", auth: "required" },
  {
    segment: "notifications",
    binding: "SVC_NOTIFICATION",
    auth: "required",
    internalOnlyPaths: ["/notifications/notify", "/notifications/internal/"],
  },
  // In-app feedback/contact widget -> notification-service (same binding as the inbox).
  // POST /feedback (any authed user submits) + GET /feedback & PATCH /feedback/:id/read
  // (admin-only, enforced in-service via notif:admin). Kept on its own top-level segment
  // so the frontend path stays simple (/api/v1/feedback).
  { segment: "feedback", binding: "SVC_NOTIFICATION", auth: "required" },
  { segment: "files", binding: "SVC_FILE_META", auth: "required" }, // body cap resolved from env at runtime
  { segment: "drive", binding: "SVC_DRIVE_PROXY", auth: "required" },
  { segment: "chat", binding: "SVC_CHAT", auth: "required" }, // HTTP only; WS upgrade is rejected
  {
    // User-facing mail: inbox reads (/mail/messages, /mail/threads) + compose
    // (/mail/outbox) reach mail-gateway with the session's x-dub-user-id, which it
    // authorizes (mail:read / mail:send). The raw system send (/mail/send) and any
    // /mail/internal/* stay internal-only → 404 externally (open-relay guard).
    segment: "mail",
    binding: "SVC_MAIL_GATEWAY",
    auth: "required",
    internalOnlyPaths: ["/mail/send", "/mail/internal/"],
  },
  { segment: "deploy", binding: "SVC_DEPLOY", auth: "required" },
  { segment: "github", binding: "SVC_GITHUB_SYNC", auth: "required" },
  // All of audit-log's write surface is internal-only: /internal/log (sync fail-close)
  // and /internal/audit-async (the free-tier outbox drain landing). Prefix-match the
  // whole /audit/internal/ tree (like identity/notifications/mail) so every current and
  // future internal write route 404s at the edge — double-defense over the receiver's
  // own x-dub-internal guard. (The drain itself uses the SVC_AUDIT binding, not the gateway.)
  { segment: "audit", binding: "SVC_AUDIT_LOG", auth: "required", internalOnlyPaths: ["/audit/internal/"] },
  { segment: "webhooks", binding: "SVC_WEBHOOK_INGEST", auth: "required" },
] as const;

const ROUTE_BY_SEGMENT = new Map<string, GatewayRoute>(ROUTES.map((r) => [r.segment, r]));

export function routeForSegment(segment: string): GatewayRoute | undefined {
  return ROUTE_BY_SEGMENT.get(segment);
}

/** Remove API_PREFIX only. "/api/v1/tasks/x" -> "/tasks/x". Returns null if not under prefix. */
export function stripApiPrefix(pathname: string): string | null {
  if (pathname === API_PREFIX) return "/";
  if (pathname.startsWith(API_PREFIX + "/")) return pathname.slice(API_PREFIX.length);
  return null;
}

/** First path segment of a post-strip internal path. "/tasks/x" -> "tasks". */
export function firstSegment(internalPath: string): string {
  const p = internalPath.replace(/^\/+/, "");
  const slash = p.indexOf("/");
  return slash === -1 ? p : p.slice(0, slash);
}

/** True when the post-strip path hits an internal-only rule (=> 404 externally). */
export function isInternalOnly(route: GatewayRoute, internalPath: string): boolean {
  if (!route.internalOnlyPaths) return false;
  return route.internalOnlyPaths.some((pat) =>
    pat.endsWith("/") ? internalPath.startsWith(pat) : internalPath === pat || internalPath.startsWith(pat + "/"),
  );
}
