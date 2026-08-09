-- mail-automation D1 schema (namespace: mailauto_*). Owns rules, templates,
-- decisions (idempotency + trail), thread state, rate counters, settings, and the
-- envelope-idempotency ledger. No mail bodies stored (gateway messageId only).
--
-- NOTE (P0b decision #12): the physical home for migrations is
-- infra/d1/migrations/<ns>/ against the single shared dub-core DB. This file is the
-- unit-owned source; the infra aggregation step copies it there. Timestamps are
-- always written by the app (nowIso) — no DDL DEFAULT on time columns.

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
