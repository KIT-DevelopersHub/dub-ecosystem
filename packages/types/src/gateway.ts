// gateway — api-gateway namespace (only external HTTP boundary). Composes only.
import type { OrgId, EpochMs } from "./common";
import type { UserSummary, PermissionKey } from "./identity";
import type { EventSummary } from "./event";

export interface MeResponse {
  user: UserSummary;
  orgId: OrgId;
  permissions: PermissionKey[];
  sessionExpiresAt: EpochMs; // epoch-ms exception (theme10)
}

export interface BffHomeResponse {
  upcomingEvents: EventSummary[];
  unreadCount: number;
  partialErrors: UpstreamPartialError[]; // BFF aggregation tolerates partial upstream failure
}

export interface UpstreamPartialError {
  source: string; // upstream service name
  code: string;
}

export interface RouteRule {
  prefix: string; // "/api/v1/tasks"
  service: string; // target binding name
  stripPrefix: boolean;
  internalOnly: boolean; // internalOnlyPaths -> 404 externally
}

export type PublicInquiryKind = "general" | "sponsor" | "press";
export interface PublicInquiryRequest {
  kind: PublicInquiryKind;
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
}
export interface PublicInquiryResponse {
  accepted: boolean;
}

// ---- public 参加届 (unauthenticated) --------------------------------------------
// POST /api/v1/public/participation — a participant files their own 参加届 without
// signing in. The gateway (optionally Turnstile-gated, always rate-limited) forwards
// it to member-service's internal route with a system actor. The response is
// deliberately minimal (no roster/member echo) so an unauthenticated caller learns
// nothing about who is on the roster — only that their submission was accepted.
export interface PublicParticipationRequest {
  name: string;
  /** 学校メールアドレス (必須・メール形式). */
  schoolEmail: string;
  /** Gmail アドレス (必須・メール形式). */
  gmail: string;
  nameKana?: string | null;
  grade?: string | null;
  department?: string | null;
  desiredTeamId?: string | null;
  desiredActivity?: string | null;
  note?: string | null;
  /** Cloudflare Turnstile token — required only when the gateway has TURNSTILE_SECRET. */
  turnstileToken?: string | null;
}
export interface PublicParticipationResponse {
  accepted: boolean;
  /** How it resolved on the roster (no member identity leaked). */
  matchKind: "linked_existing" | "created_new";
}
