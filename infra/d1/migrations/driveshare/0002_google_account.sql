-- namespace: driveshare | owner: drive-share-service (Hackit Drive Google accounts)
-- The Google accounts drive-share-service can act as, registered from ロール管理 (その他 >
-- Google アカウント). Admins register several and switch which one is in use; with none in use
-- the GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN secret stays the fallback. Refresh tokens are AES-GCM
-- encrypted with the DRIVESHARE_TOKEN_ENC_KEY secret — plaintext never touches D1. All
-- timestamps are written by the service (nowIso), never via DDL DEFAULT (D2).

-- One row per registered account. Reconnecting the same address replaces its token in place.
-- client_id records which OAuth client issued the token (a refresh token only works with the
-- client that minted it).
CREATE TABLE driveshare_google_accounts (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  email          TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  token_cipher   TEXT NOT NULL,
  token_iv       TEXT NOT NULL,
  connected_by   TEXT NOT NULL,
  connected_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (org_id, email)
);

-- Which registered account is in use (one per org). No row = the secret fallback.
CREATE TABLE driveshare_google_active_account (
  org_id       TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES driveshare_google_accounts(id),
  switched_by  TEXT NOT NULL,
  switched_at  TEXT NOT NULL
);

-- Pending OAuth consent round-trips (CSRF state). Single-use: the callback deletes the
-- row it consumes; expired rows are purged when the next round-trip starts. Kept in D1,
-- not KV, so no session-shared KV write budget is spent.
CREATE TABLE driveshare_google_oauth_states (
  state        TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_driveshare_google_oauth_states_expires ON driveshare_google_oauth_states(expires_at);
