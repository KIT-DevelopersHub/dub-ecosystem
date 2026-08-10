-- notification service (#8) — notif_ namespace, additive slice: in-app feedback.
-- The authenticated analogue of the public inquiry flow. A signed-in user submits
-- "fix this here" feedback via the app's widget; it is stored append-only and admins
-- read it (GET /feedback, notif:admin). Only read_at is ever mutated (admin triage);
-- the reported content is immutable. created_at is stamped app-side (nowIso); a DDL
-- DEFAULT on timestamps is banned (theme3 D2). No updated_at by design (append-only,
-- read_at is the sole mutable column) — the missing-timestamps lint is a warn only.

CREATE TABLE IF NOT EXISTS notif_feedback (
  id          TEXT PRIMARY KEY,                                    -- prefix-ULID "nfb_…"
  user_id     TEXT NOT NULL,                                       -- submitter (x-dub-user-id)
  category    TEXT NOT NULL DEFAULT 'other'
              CHECK (category IN ('bug','idea','question','other')),
  message     TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  page_url    TEXT,                                                -- originating page URL (nullable)
  page_name   TEXT,                                                -- originating screen name (nullable)
  user_agent  TEXT,                                                -- best-effort UA context (nullable)
  request_id  TEXT NOT NULL,                                       -- correlation id
  read_at     TEXT,                                                -- ISO8601 / NULL = unread (admin triage)
  created_at  TEXT NOT NULL
);

-- admin list: newest-first, id-cursor paged.
CREATE INDEX IF NOT EXISTS idx_notif_feedback_created ON notif_feedback(created_at DESC);
-- unread triage lane.
CREATE INDEX IF NOT EXISTS idx_notif_feedback_unread ON notif_feedback(id) WHERE read_at IS NULL;
