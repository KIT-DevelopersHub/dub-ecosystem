-- GET /usage/summary (and the home BFF) reads MAX(captured_at) on every call; without an
-- index that is a full table scan. Additive.
CREATE INDEX IF NOT EXISTS idx_usage_snapshot_captured ON usage_snapshot(captured_at);
