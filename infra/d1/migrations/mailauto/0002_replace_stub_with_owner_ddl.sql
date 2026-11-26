-- namespace: mailauto | owner: mail-automation (#16) | #836
-- Replaces the P0b AGGREGATION STUB (0001_init.sql here) with the owner's real DDL
-- (services/mail-automation/migrations/0001_init.sql). The stub's columns
-- (match_json, value_json, bucket, ...) are not the ones the service reads/writes, and
-- mailauto_processed_events was missing, so the service could not run against prod.
--
-- DESTRUCTIVE BY DESIGN, SAFE ONLY BECAUSE EMPTY: verified 2026-11-25 on prod dub-core that
-- every mailauto_* table has 0 rows (the service never ran). Re-check before applying:
--   SELECT (SELECT count(*) FROM mailauto_rules)+(SELECT count(*) FROM mailauto_templates)
--         +(SELECT count(*) FROM mailauto_decisions)+(SELECT count(*) FROM mailauto_thread_state)
--         +(SELECT count(*) FROM mailauto_rate_counters)+(SELECT count(*) FROM mailauto_settings) AS n;
-- Apply only when n = 0.
DROP TABLE mailauto_decisions;
DROP TABLE mailauto_rules;
DROP TABLE mailauto_templates;
DROP TABLE mailauto_thread_state;
DROP TABLE mailauto_rate_counters;
DROP TABLE mailauto_settings;

CREATE TABLE mailauto_rules (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 100,
  conditions    TEXT NOT NULL,             -- JSON: RuleCondition[]
  action        TEXT NOT NULL,             -- JSON: RuleAction
  event_id      TEXT,
  rate_limit_per_recipient_per_day INTEGER NOT NULL DEFAULT 5,
  deleted_at    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_mailauto_rules_enabled ON mailauto_rules(enabled, priority);

CREATE TABLE mailauto_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  variables     TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- decision log = idempotency key (gateway_message_id UNIQUE) + primary trail
CREATE TABLE mailauto_decisions (
  id                  TEXT PRIMARY KEY,
  gateway_message_id  TEXT NOT NULL UNIQUE,
  thread_id           TEXT NOT NULL,
  from_addr           TEXT NOT NULL,
  outcome             TEXT NOT NULL,        -- DecisionOutcome
  matched_rule_id     TEXT,
  sent_message_id     TEXT,
  suppress_reasons    TEXT NOT NULL DEFAULT '[]',
  decided_at          TEXT NOT NULL
);
CREATE INDEX idx_mailauto_decisions_thread ON mailauto_decisions(thread_id);
CREATE INDEX idx_mailauto_decisions_time ON mailauto_decisions(decided_at);

-- thread round-trip detection (cumulative auto-replies)
CREATE TABLE mailauto_thread_state (
  thread_id        TEXT PRIMARY KEY,
  auto_reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at    TEXT
);

-- per-recipient daily rate counter (old days pruned by cron)
CREATE TABLE mailauto_rate_counters (
  recipient  TEXT NOT NULL,
  day        TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recipient, day)
);

CREATE TABLE mailauto_settings (
  key        TEXT PRIMARY KEY,             -- 'automation_enabled' etc.
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- envelope idempotency ledger (Queue re-delivery dedup by envelope.id)
CREATE TABLE mailauto_processed_events (
  event_id     TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
