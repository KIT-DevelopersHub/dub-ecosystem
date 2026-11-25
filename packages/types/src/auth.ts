// auth — auth-service namespace (Google OAuth + KV session).
import type { UserId, EpochMs } from "./common";
import { API_PREFIX } from "./common";

export type AuthClient = "web" | "mobile";
export type AuthVerifyReason = "malformed" | "expired" | "revoked";

export interface SessionInfo {
  userId: UserId;
  client: AuthClient;
  sessionExpiresAt: EpochMs; // epoch-ms exception (theme10)
}

export interface AuthLoginStartRequest {
  redirectUri: string;
  client?: AuthClient;
}
// email+password credential login (web). Additive to the Google OAuth path; on
// success the session cookie is set exactly as the OAuth callback does.
export interface AuthPasswordLoginRequest {
  email: string;
  password: string;
}
// self password change (#5b): the logged-in user changes their OWN password. Reaches
// the gateway at POST /api/v1/me/password (session required); the current password is
// re-verified server-side before the new hash is stored.
export interface SelfPasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}
// admin sets/re-issues a user's initial password (#5a) via the gateway at
// POST /api/v1/admin/users/:userId/password (identity:admin). Omit `password` (or pass
// generate=true) to auto-generate a strong one. `mustChange` defaults true.
export interface AdminSetPasswordRequest {
  password?: string;
  generate?: boolean;
  mustChange?: boolean;
}
// Response of the admin set/re-issue call. `password` is present ONLY when the server
// generated it — it is returned exactly ONCE and never stored in plaintext.
export interface AdminSetPasswordResponse {
  ok: true;
  password?: string;
}
// admin views a user's current password (#5c) via the gateway at
// GET /api/v1/admin/users/:userId/password (identity:admin). The plaintext is decrypted
// on demand from the AES-GCM copy and every view is audited (auth.password.viewed).
export interface AdminViewPasswordResponse {
  userId: UserId;
  email: string;
  password: string;
}
// admin sends the account-issue mail (アカウント発行メール) to a linked 運営メンバー via the
// gateway at POST /api/v1/admin/users/:userId/account-mail (identity:admin). Body is empty.
// The gateway resolves the member's Gmail (to) + the @developershub.jp login (cc), reuses
// the current password or issues one (mustChange), and sends ONE mail. The password itself
// is never echoed back.
export interface AdminSendAccountMailResponse {
  ok: true;
  to: string;
  cc: string;
  appUrl: string;
  passwordSource: "existing" | "generated";
  messageId: string;
}
export interface AuthVerifyRequest {
  token: string;
}
export interface AuthVerifyResponse {
  valid: boolean;
  userId: UserId | null;
  session: SessionInfo | null;
  reason: AuthVerifyReason | null; // non-null only when valid=false
  /**
   * Present (non-null) only when the token is an ADMIN IMPERSONATION session: `userId` is
   * then the SUBJECT (whose account is being viewed) and every downstream service acts with
   * the subject's permissions. Additive + optional — a verifier that omits it means "not
   * impersonating", which is the backward-compatible reading.
   */
  impersonation?: ImpersonationInfo | null;
}
export interface AuthRefreshRequest {
  refreshToken?: string; // mobile path; web uses cookie
}
export interface MobileExchangeRequest {
  code: string;
}
// preview/local only; excluded from production build (theme8)
export interface TestLoginRequest {
  userId: UserId;
}

// ---- STAGING ONLY: one-click demo sign-in + debug-menu account switcher ----
// Both routes exist only when the auth-service runs with DEMO_AUTOLOGIN=1 (staging);
// production does not register them (404). The switchable accounts are a fixed,
// server-side allowlist of seed/test accounts — the client can only pick from it.
/** POST /auth/demo-login body. Omit `email` (or send `{}`) for the default demo admin. */
export interface DemoLoginRequest {
  email?: string;
}
/** One switchable seed account (only accounts that are ACTIVE on the roster are listed). */
export interface DemoAccount {
  email: string;
  userId: UserId;
  displayName: string;
  /** Short role hint for the menu (e.g. "admin"); the real permissions come from /me. */
  label: string;
  /** True for the default account used by an empty POST /auth/demo-login. */
  isDefault: boolean;
}
/** GET /auth/demo-accounts response. */
export interface DemoAccountsResponse {
  accounts: DemoAccount[];
}

// ---- admin impersonation (代理ログイン / 「このメンバーとして表示」) ----
// An admin holding `identity:impersonate` views the app as another member to debug what
// that member sees. The impersonation session is a SEPARATE short-lived session whose
// userId is the subject; the admin's own session is kept server-side and restored on stop.
//   start: POST /api/v1/admin/users/:userId/impersonation  (gateway-owned, identity:impersonate)
//   stop:  POST /api/v1/auth/impersonation/stop            (auth segment, the impersonation cookie)
// No refresh: a refresh of an impersonation token ENDS it and rotates back to the admin.

/** The permission that allows starting an impersonation. Never held by the subject. */
export const IMPERSONATE_PERMISSION = "identity:impersonate" as const;
/** The super-admin system role. Its holders can never be impersonated (no admin→admin). */
export const SYS_ADMIN_ROLE_ID = "role_sys_admin";
/** Default impersonation lifetime (auth-service IMPERSONATION_TTL_SEC overrides). */
export const IMPERSONATION_DEFAULT_TTL_SEC = 60 * 60;

export interface ImpersonationInfo {
  /** The real admin behind the session (audit actor). */
  actorId: UserId;
  /** The member being viewed (= the session's userId). */
  subjectId: UserId;
  startedAt: EpochMs;
  /** Hard deadline — never extended (no refresh). */
  expiresAt: EpochMs;
}

/** POST /api/v1/admin/users/:userId/impersonation response (the cookie is set alongside). */
export interface StartImpersonationResponse {
  impersonation: ImpersonationInfo;
}

/** Why a target cannot be impersonated (server 403 details.reason + UI disabled reason). */
export type ImpersonationRefusal = "self" | "inactive" | "privileged" | "nested";

export const IMPERSONATION_REFUSAL_LABEL: Record<ImpersonationRefusal, string> = {
  self: "自分自身は選べません",
  inactive: "利用中ではないメンバー（利用停止・招待中など）は選べません",
  privileged: "管理者（代理表示の権限を持つメンバー）は選べません",
  nested: "代理表示中は別のメンバーに切り替えられません",
};

export interface ImpersonationTarget {
  id: UserId;
  status: string;
  roleIds: readonly string[];
  /** Whether the target holds IMPERSONATE_PERMISSION (effective, resolved from roles). */
  holdsImpersonate: boolean;
}

/**
 * THE eligibility rule, shared by auth-service (authoritative) and the roster UI (which only
 * greys the button). Returns null when allowed. Order matters only for the message shown.
 */
export function impersonationRefusal(input: {
  actorId: UserId;
  /** The actor's current session is itself an impersonation. */
  actorImpersonating?: boolean;
  target: ImpersonationTarget;
}): ImpersonationRefusal | null {
  if (input.actorImpersonating) return "nested";
  if (input.target.id === input.actorId) return "self";
  if (input.target.status !== "active") return "inactive";
  if (input.target.holdsImpersonate || input.target.roleIds.includes(SYS_ADMIN_ROLE_ID)) return "privileged";
  return null;
}

// ---- what is NEVER done as someone else (enforced by api-gateway) ----
// While impersonating, requests act with the SUBJECT's permissions — except these
// high-risk actions, refused at the edge (403 IMPERSONATION_ACTION_BLOCKED) even when the
// member could perform them. Mail policy: SENDING as the member is blocked (outbox /
// schedule / forwarding rules); composing and reading are not. auth-service separately
// refuses its own credential routes (password, passkeys) because the edge does not verify
// the auth segment. There is no API-token feature yet; add its create route here when one
// lands. Paths are EXTERNAL (as the browser calls them). One line per rule.
export interface ImpersonationBlockRule {
  /** Methods the rule applies to; "*" = any non-read method. */
  methods: readonly string[] | "*";
  /** Prefix (ending in "/") or exact path; exact also matches `${path}/...`. */
  path: string;
  /** Machine reason (audit + 403 details.reason). */
  reason: string;
}

export const IMPERSONATION_BLOCK_RULES: readonly ImpersonationBlockRule[] = [
  { methods: "*", path: `${API_PREFIX}/me/password`, reason: "credential_change" },
  { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], path: `${API_PREFIX}/admin/`, reason: "admin_surface" },
  { methods: "*", path: `${API_PREFIX}/identity/`, reason: "identity_change" },
  { methods: "*", path: `${API_PREFIX}/members/role-sync/`, reason: "role_change" },
  { methods: ["POST"], path: `${API_PREFIX}/mail/outbox`, reason: "mail_send" },
  { methods: ["POST", "PATCH"], path: `${API_PREFIX}/mail/scheduled`, reason: "mail_send" },
  { methods: ["PUT", "PATCH"], path: `${API_PREFIX}/mail/forward`, reason: "mail_forwarding" },
];

/** Japanese copy for a blocked action (toast / error dialog). */
export const IMPERSONATION_BLOCKED_MESSAGE = "代理表示中はこの操作（パスワード・権限の変更、メール送信など）はできません";

const IMPERSONATION_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The block reason for a request made while impersonating, or null when allowed. */
export function impersonationBlockReason(method: string, externalPath: string): string | null {
  const m = method.toUpperCase();
  for (const rule of IMPERSONATION_BLOCK_RULES) {
    const methodHit = rule.methods === "*" ? !IMPERSONATION_READ_METHODS.has(m) : rule.methods.includes(m);
    const pathHit = rule.path.endsWith("/")
      ? externalPath.startsWith(rule.path)
      : externalPath === rule.path || externalPath.startsWith(rule.path + "/");
    if (methodHit && pathHit) return rule.reason;
  }
  return null;
}
