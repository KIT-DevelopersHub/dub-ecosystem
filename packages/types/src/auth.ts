// auth — auth-service namespace (Google OAuth + KV session).
import type { UserId, EpochMs } from "./common";

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
export interface AuthVerifyRequest {
  token: string;
}
export interface AuthVerifyResponse {
  valid: boolean;
  userId: UserId | null;
  session: SessionInfo | null;
  reason: AuthVerifyReason | null; // non-null only when valid=false
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
