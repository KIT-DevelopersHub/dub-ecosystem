-- notification service (#8) — notif_ namespace, additive slice: device context on feedback.
-- Which client a submission came from (iOS/Android/desktop app or mobile/PC web), its OS,
-- browser, viewport and app version, so a bug report can be reproduced on the right
-- device. The raw UA keeps using the existing user_agent column.
--
-- Non-destructive ADD COLUMNs, all nullable: EXISTING rows stay NULL (= unknown). No CHECK
-- on `client` (same reason as 0005: SQLite cannot widen a CHECK without a rebuild); the
-- vocabulary is validated app-side (notification.FEEDBACK_CLIENTS). No IP is stored.
ALTER TABLE notif_feedback ADD COLUMN client TEXT;
ALTER TABLE notif_feedback ADD COLUMN os TEXT;
ALTER TABLE notif_feedback ADD COLUMN os_version TEXT;
ALTER TABLE notif_feedback ADD COLUMN browser TEXT;
ALTER TABLE notif_feedback ADD COLUMN screen_width INTEGER;
ALTER TABLE notif_feedback ADD COLUMN screen_height INTEGER;
ALTER TABLE notif_feedback ADD COLUMN app_version TEXT;
ALTER TABLE notif_feedback ADD COLUMN app_build TEXT;
