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
