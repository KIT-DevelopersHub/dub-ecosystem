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
