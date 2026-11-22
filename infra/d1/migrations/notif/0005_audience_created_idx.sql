-- Bounds backfillAdminAudienceInbox on the polled unread-count path (audience + created_at
-- range) instead of reading every audience='admin' row each minute. Additive.
CREATE INDEX IF NOT EXISTS idx_notif_audience_created ON notif_notifications(audience, created_at);
