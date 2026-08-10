// auth-service specific error codes (open half of the catalog, SCREAMING_SNAKE).
// Common codes (RATE_LIMITED etc.) come from @dub/errors directly.
import { DubError } from "@dub/errors";

export const AuthErrorCodes = {
  INVALID_TOKEN: "AUTH_INVALID_TOKEN", // 401 malformed / not in KV
  SESSION_EXPIRED: "AUTH_SESSION_EXPIRED", // 401 access expired (refreshable)
  SESSION_REVOKED: "AUTH_SESSION_REVOKED", // 401 logged out / force-revoked / abs-expired
  OAUTH_EXCHANGE_FAILED: "AUTH_OAUTH_EXCHANGE_FAILED", // 502 Google token/id_token failure (mobile exchange)
  USER_REJECTED: "AUTH_USER_REJECTED", // 403 identity provision rejected (invite-only)
  INTERNAL_FORBIDDEN: "AUTH_INTERNAL_FORBIDDEN", // 403 x-dub-internal missing on internal route
  TEST_LOGIN_DISABLED: "AUTH_TEST_LOGIN_DISABLED", // 403 test-login off / production
  INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS", // 401 email/password login: unknown email OR wrong password (no enumeration)
  DOMAIN_NOT_ALLOWED: "AUTH_DOMAIN_NOT_ALLOWED", // 403 email is not on the allowed company login domain
} as const;

export const authErrors = {
  invalidToken(message = "Invalid token"): DubError {
    return new DubError(AuthErrorCodes.INVALID_TOKEN, message, { status: 401 });
  },
  sessionExpired(message = "Session expired"): DubError {
    return new DubError(AuthErrorCodes.SESSION_EXPIRED, message, { status: 401 });
  },
  sessionRevoked(message = "Session revoked"): DubError {
    return new DubError(AuthErrorCodes.SESSION_REVOKED, message, { status: 401 });
  },
  oauthExchangeFailed(cause?: unknown): DubError {
    return new DubError(AuthErrorCodes.OAUTH_EXCHANGE_FAILED, "OAuth code exchange failed", {
      status: 502,
      cause,
      retryable: false,
    });
  },
  userRejected(message = "User is not permitted (invite-only)"): DubError {
    return new DubError(AuthErrorCodes.USER_REJECTED, message, { status: 403 });
  },
  internalForbidden(message = "Internal endpoint requires service binding"): DubError {
    return new DubError(AuthErrorCodes.INTERNAL_FORBIDDEN, message, { status: 403 });
  },
  testLoginDisabled(message = "test-login is disabled"): DubError {
    return new DubError(AuthErrorCodes.TEST_LOGIN_DISABLED, message, { status: 403 });
  },
  // Deliberately generic (same code + message whether the email is unknown or the
  // password is wrong) so the endpoint can't be used to enumerate accounts.
  invalidCredentials(message = "Invalid email or password"): DubError {
    return new DubError(AuthErrorCodes.INVALID_CREDENTIALS, message, { status: 401 });
  },
  // Email is not on the allowed company login domain. Distinct from invalidCredentials:
  // this is a policy decision about the email's domain (public info), so it reveals
  // nothing about whether the account exists.
  domainNotAllowed(message = "Login is restricted to company accounts"): DubError {
    return new DubError(AuthErrorCodes.DOMAIN_NOT_ALLOWED, message, { status: 403 });
  },
};
