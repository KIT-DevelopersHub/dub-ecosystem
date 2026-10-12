-- commander — staging 合体 (bundle). Several demo-approved tasks waiting for a staging slot
-- are merged into ONE integration branch (a do-not-merge viewer PR) and share one slot.
-- Children keep their own task / runs / PR / approval; the bundle only references them.
--   task_ids : JSON array of commander_tasks.id (insertion order). Empty => row is deleted.
--   status   : merging (run building/deploying) | deployed | failed
--   markers  : JSON object taskId -> pending | pass | missing (verify-live per child)
--   run_id   : the run that builds + deploys the bundle; its result reports back here.

CREATE TABLE IF NOT EXISTS commander_staging_bundles (
  id          TEXT PRIMARY KEY,
  task_ids    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'merging'
              CHECK (status IN ('merging', 'deployed', 'failed')),
  slot        TEXT CHECK (slot IS NULL OR slot IN ('staging', 'staging2')),
  staging_url TEXT,
  pr_url      TEXT,
  branch      TEXT NOT NULL,
  markers     TEXT NOT NULL DEFAULT '{}',
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_staging_bundles_run
  ON commander_staging_bundles (run_id);
