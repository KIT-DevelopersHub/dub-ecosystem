-- notification service (#8) — notif_ namespace, additive slice: notification audience.
-- Notification management (2026-08): every notification carries an audience so admin-facing
-- update notifications (deploy done / feedback / ops alerts) stay hidden from general
-- members until an admin publishes them as a members broadcast.
--
-- Non-destructive ADD COLUMN with a DEFAULT of 'members' so every EXISTING row (direct
-- task/event notifications AND release broadcasts) stays visible to the user it targets —
-- i.e. zero behaviour change for anything already shipped. The admin-facing notifications
-- explicitly ride as 'admin' (app-side). A CHECK closes the value set.
ALTER TABLE notif_notifications
  ADD COLUMN audience TEXT NOT NULL DEFAULT 'members'
  CHECK (audience IN ('admin','members'));

-- Admin management list: audience='admin', newest-first (id DESC), id-cursor paged.
CREATE INDEX IF NOT EXISTS idx_notif_audience ON notif_notifications(audience, id);
