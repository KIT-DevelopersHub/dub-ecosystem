-- namespace: driveshare | owner: drive-share-service (Hackit Drive Google account)
-- The Google account drive-share-service acts as, connected from ロール管理 (Drive共有 の詳細
-- ダイアログ). Replaces the GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN secret when present; the secret
-- stays the fallback. The refresh token is AES-GCM encrypted with the
-- DRIVESHARE_TOKEN_ENC_KEY secret — plaintext never touches D1. All timestamps are written
-- by the service (nowIso), never via DDL DEFAULT (D2).

-- One row per org: the currently connected account. client_id records which OAuth client
-- issued the token (a refresh token only works with the client that minted it).
CREATE TABLE driveshare_google_account (
  org_id         TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  token_cipher   TEXT NOT NULL,
  token_iv       TEXT NOT NULL,
  connected_by   TEXT NOT NULL,
  connected_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
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
