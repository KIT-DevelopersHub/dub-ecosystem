// gateway — api-gateway namespace (only external HTTP boundary). Composes only.
import type { OrgId, EpochMs } from "./common";
import type { UserSummary, PermissionKey } from "./identity";
import type { EventSummary } from "./event";
import type { TaskStatus } from "./task";

export interface MeResponse {
  user: UserSummary;
  orgId: OrgId;
  permissions: PermissionKey[];
  sessionExpiresAt: EpochMs; // epoch-ms exception (theme10)
}

// ---- self profile (アカウント設定 → 表示名/アバター) -------------------------------
// GET/POST /api/v1/me/profile — the signed-in user reads/edits their OWN identity
// display name + avatar (session-scoped, no target id — unlike FE7's admin roster
// PATCH /identity/users/:id). The gateway authenticates the session, then forwards to
// identity-roster as a genuine s2s call scoped to the caller's userId.
export interface MeProfileResponse {
  displayName: string;
  /** Avatar image reference. Currently a URL or data: URL string (最小実装); a future
   *  R2-backed object URL will replace inline data URLs (本番課題・TODO). null = initials. */
  avatarUrl: string | null;
}
/** Patch body for the self profile. Both optional so the caller can patch just one;
 *  `avatarUrl: null` clears the avatar (back to initials). */
export interface MeProfileUpdateRequest {
  displayName?: string;
  avatarUrl?: string | null;
}

export interface BffHomeResponse {
  upcomingEvents: EventSummary[];
  unreadCount: number;
  // Home dashboard aggregates — each is a small BFF-owned PROJECTION of a real
  // upstream (task-service / usage-meter / member-service), NOT a copy of that
  // service's frozen contract. Optional: absent when the source degraded (its
  // failure is listed in partialErrors instead). The shell renders a per-frame
  // "取得できませんでした" fallback when the matching source is in partialErrors.
  taskSummary?: HomeTaskSummary; // caller's own task breakdown (my tasks)
  usageSummary?: HomeUsageSummary; // free-tier usage snapshot (org-wide)
  orgStats?: HomeOrgStats; // 運営メンバー / チーム の総数
  partialErrors: UpstreamPartialError[]; // BFF aggregation tolerates partial upstream failure
}

/** Breakdown of the caller's own tasks by status (source: task-service /tasks). */
export interface HomeTaskSummary {
  total: number; // counted across all statuses below
  byStatus: Record<TaskStatus, number>;
}

/** One free-tier metric for the home dashboard. `pct` is the wire-precomputed
 *  0–100 utilisation (null when the metric could not be measured). The shell
 *  derives health/color from `pct` via the existing usageStatusFromPct mapping —
 *  the projection carries no status enum so it never drifts from the usage view. */
export interface HomeUsageMetric {
  key: string; // upstream metricKey (e.g. "kv_reads_day")
  label: string; // JP display label
  pct: number | null;
}

/** Free-tier usage snapshot (source: usage-meter /usage/summary), projected to just
 *  the fields the home dashboard shows. `worst` is the single most-stressed metric. */
export interface HomeUsageSummary {
  metrics: HomeUsageMetric[];
  worst: HomeUsageMetric | null;
}

/** 運営メンバー / チーム の総数 (source: member-service /members/overview). */
export interface HomeOrgStats {
  members: number;
  teams: number;
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
  /** 苗字(姓) — 必須 (分割入力). */
  lastName?: string | null;
  /** 名前(名) — 必須 (分割入力). */
  firstName?: string | null;
  /** 氏名 (合成値・後方互換). 姓/名 が来た時はサーバが合成する。 */
  name?: string;
  /** 学校メールアドレス (必須・メール形式). */
  schoolEmail: string;
  /** Gmail アドレス (必須・メール形式). */
  gmail: string;
  nameKana?: string | null;
  /** 振り仮名(せい) (任意). */
  lastNameKana?: string | null;
  /** 振り仮名(めい) (任意). */
  firstNameKana?: string | null;
  /** 氏名ローマ字 (合成値・後方互換). */
  nameRomaji?: string | null;
  /** 苗字(姓) ローマ字 (任意・英字). アルファベットのメール発行に使う。 */
  lastNameRomaji?: string | null;
  /** 名前(名) ローマ字 (任意・英字). アルファベットのメール発行に使う。 */
  firstNameRomaji?: string | null;
  /** 電話番号 (任意). */
  phone?: string | null;
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
  /** @deprecated 名簿への反映は管理者が後から確定するため、提出時点では解決しない。
   *  常に省略/undefined（後方互換のためフィールドは残置）。 */
  matchKind?: "linked_existing" | "created_new";
}
