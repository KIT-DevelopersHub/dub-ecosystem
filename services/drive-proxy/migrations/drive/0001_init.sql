-- drive-proxy (#11) — Drive push-watch channel registry (P1 Drive-watch seam).
-- This is drive-proxy's OWN operational state (channel lifecycle), NOT file metadata:
-- file-meta-service remains the metadata source of truth. The table records the
-- channels drive-proxy issues via files.watch so they can be renewed/stopped and so
-- inbound notifications (X-Goog-Channel-Id/Resource-Id) can be correlated.
--
-- Conventions mirror the ecosystem (D2 no DDL DEFAULT — app nowIso(); prefix-ULID PK
-- via newId("dwc")). The shared channel token is a SECRET and is NEVER stored here;
-- only which secret slot minted it (token_version) is recorded, for rotation audits.
CREATE TABLE drive_watch_channels (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,                 -- X-Goog-Channel-Id (we mint; opaque uuid)
  resource_id   TEXT NOT NULL,                 -- Google resourceId (required to stop)
  file_id       TEXT NOT NULL,                 -- watched Drive file/folder id
  token_version TEXT NOT NULL CHECK (token_version IN ('current','next')),
  address       TEXT NOT NULL,                 -- https callback (webhook-ingest ingress)
  expiration    TEXT,                          -- ISO8601 channel expiry (Google-capped)
  status        TEXT NOT NULL CHECK (status IN ('active','stopped')),
  actor_id      TEXT,
  request_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (channel_id)
);

CREATE INDEX idx_drive_watch_channels_file ON drive_watch_channels (file_id, status);
CREATE INDEX idx_drive_watch_channels_status_exp ON drive_watch_channels (status, expiration);
