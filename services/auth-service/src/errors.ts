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
  DOMAIN_NOT_ALLOWED: "AUTH_DOMAIN_NOT_ALLOWED", // 403 email is not on the allowed company login domain (optional filter)
  NOT_ON_ALLOWLIST: "AUTH_NOT_ON_ALLOWLIST", // 403 email is not an active identity-roster user (login allowlist)
  PASSWORD_NOT_VIEWABLE: "AUTH_PASSWORD_NOT_VIEWABLE", // 409 no encrypted copy stored for this credential (admin view)
  ENC_KEY_UNAVAILABLE: "AUTH_ENC_KEY_UNAVAILABLE", // 500 PASSWORD_ENC_KEY missing/invalid — admin view/encrypt cannot run
  PASSKEY_DISABLED: "AUTH_PASSKEY_DISABLED", // 404 WEBAUTHN_RP_ID/ORIGINS not configured for this environment
  PASSKEY_FAILED: "AUTH_PASSKEY_FAILED", // 401 login / 400 registration: ceremony rejected (challenge, credential, signature, counter)
  STEP_UP_FAILED: "AUTH_STEP_UP_FAILED", // 403 password re-entry before a sensitive action was wrong
  PASSKEY_DUPLICATE: "AUTH_PASSKEY_DUPLICATE", // 409 this authenticator is already registered
  LAST_AUTH_METHOD: "AUTH_LAST_AUTH_METHOD", // 409 refusing to delete the user's only remaining way to sign in
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
  // Email is not an ACTIVE identity-roster user. This is the primary login gate
  // (theme #4): access is restricted to the roster allowlist, not a whole domain.
  notOnAllowlist(message = "This account is not permitted to log in"): DubError {
    return new DubError(AuthErrorCodes.NOT_ON_ALLOWLIST, message, { status: 403 });
  },
  // Admin view: the credential has no reversibly-encrypted copy (e.g. seeded/legacy
  // credential, or set while PASSWORD_ENC_KEY was absent). Nothing to decrypt.
  passwordNotViewable(message = "No viewable password on file for this user"): DubError {
    return new DubError(AuthErrorCodes.PASSWORD_NOT_VIEWABLE, message, { status: 409 });
  },
  // The server encryption key is missing or invalid — admin view / encrypted set
  // cannot run. A configuration problem, not a client error.
  encKeyUnavailable(message = "Password encryption key is unavailable"): DubError {
    return new DubError(AuthErrorCodes.ENC_KEY_UNAVAILABLE, message, { status: 500, retryable: false });
  },
  passkeyDisabled(message = "Passkey login is not configured"): DubError {
    return new DubError(AuthErrorCodes.PASSKEY_DISABLED, message, { status: 404 });
  },
  // Deliberately generic: the client learns only "use another method", never which check
  // failed (unknown credential vs signature vs counter) — that detail goes to audit.
  // `status` is 401 for LOGIN only. Registration runs inside a valid session, and the SPA
  // treats any 401 as "session dead" (refresh, then log out) — so a failed registration
  // must be 400, or a cancelled Touch ID prompt would sign the user out.
  passkeyFailed(status: 400 | 401 = 401, message = "Passkey verification failed"): DubError {
    return new DubError(AuthErrorCodes.PASSKEY_FAILED, message, { status });
  },
  // Wrong password on a step-up prompt. 403, not 401, for the same reason as above: the
  // session is fine, only this one action is refused.
  stepUpFailed(message = "Password is incorrect"): DubError {
    return new DubError(AuthErrorCodes.STEP_UP_FAILED, message, { status: 403 });
  },
  passkeyDuplicate(message = "This passkey is already registered"): DubError {
    return new DubError(AuthErrorCodes.PASSKEY_DUPLICATE, message, { status: 409 });
  },
  lastAuthMethod(message = "Cannot remove the last remaining sign-in method"): DubError {
    return new DubError(AuthErrorCodes.LAST_AUTH_METHOD, message, { status: 409 });
  },
};
