-- mail_send_log read paths that scanned every sent row (rows-read budget). Additive.
-- Sent lists (status = 'sent' [AND owner_user_id = ?] ORDER BY created_at DESC, id DESC LIMIT n):
-- these two serve the order directly so only ~n rows are read; the per-owner one also keeps the
-- planner from walking the shared index for a per-owner query.
CREATE INDEX IF NOT EXISTS idx_mail_send_log_status_created ON mail_send_log(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_mail_send_log_owner_status_created ON mail_send_log(owner_user_id, status, created_at, id);
-- Sent conversation summary / reply threading look sends up by thread_id.
CREATE INDEX IF NOT EXISTS idx_mail_send_log_thread ON mail_send_log(thread_id);
