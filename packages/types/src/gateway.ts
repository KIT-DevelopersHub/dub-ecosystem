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
