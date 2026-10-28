-- mail-gateway (データ保全 Phase 1) — daily row-count snapshot for silent-loss detection.
-- Mirror of services/mail-gateway/db/0015_row_count_snapshot.sql (kept byte-identical;
-- infra is the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only. The mail-gateway cron records COUNT(*) of mail_inbound and
-- mail_send_log once per UTC day; a count lower than the previous snapshot raises an
-- alert (src/row-count.ts). Mail is kept indefinitely, so a decrease is always an anomaly.
--   snapshot_date : UTC calendar day, YYYY-MM-DD.
--   table_name    : counted table ('mail_inbound' | 'mail_send_log').
--   row_count     : COUNT(*) at snapshot time.
-- Timestamps stamped app-side (nowIso); no DDL DEFAULT on them (theme3 D2).
CREATE TABLE IF NOT EXISTS mail_row_count_snapshots (
  snapshot_date TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, table_name)
);
