-- gantt namespace: per-(user,event) view state. Semantic source = gantt-service
-- design §3. Physical relocation to infra/d1/migrations/gantt/ is an infra (#27/#28)
-- concern; co-located here to keep this unit self-contained.
-- No DDL DEFAULT for timestamps (テーマ3 D2: nowIso() is the only mint).
CREATE TABLE IF NOT EXISTS gantt_view_states (
  user_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT '{}', -- GanttViewState JSON (validated in app layer)
  updated_at TEXT NOT NULL,              -- ISO8601 UTC (app-supplied)
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_gantt_view_states_event ON gantt_view_states (event_id);
