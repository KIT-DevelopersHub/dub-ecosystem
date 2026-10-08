-- namespace: identity | owner: identity-roster (#3)
-- Passkey (WebAuthn) authenticators for passwordless web login. Mirrors
-- services/identity-roster/src/schema.ts 0005_webauthn_credentials. One user may hold
-- many authenticators. id IS the WebAuthn credential id (base64url, globally unique),
-- so it doubles as the PK and the duplicate-registration guard. public_key is the COSE
-- public key (not secret). Forward-only + idempotent (IF NOT EXISTS); no datetime DEFAULTs.

CREATE TABLE IF NOT EXISTS identity_webauthn_credentials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES identity_users(id),
  public_key   TEXT NOT NULL,
  sign_count   INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,
  aaguid       TEXT,
  device_type  TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_identity_webauthn_credentials_user
  ON identity_webauthn_credentials (user_id);

-- Single-use ceremony challenges. D1, not KV: the unauthenticated login/options route
-- writes one per call, and the KV free tier (1,000 writes/day, shared with sessions)
-- would be exhaustible by an anonymous caller. DELETE ... RETURNING makes redemption
-- atomic (true single-use). Expired rows are swept on insert. user_id is set only for
-- registration challenges (bound to the session that passed step-up).
CREATE TABLE IF NOT EXISTS identity_webauthn_challenges (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('register','login')),
  user_id    TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
