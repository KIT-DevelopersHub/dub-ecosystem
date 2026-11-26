-- namespace: task | owner: task-service (#5).
-- Team assignee (担当にチームも選べる / Issue #882).
--
-- A task's 担当 can now be a person (assignee_id) OR a team (assignee_team_id). The two
-- are mutually exclusive — task-service clears the other side whenever one is set — so
-- the existing "assignee_id = me" reads keep their meaning. This is NOT the owning team
-- (team_id, the gantt scope/filter): a task owned by team A may be handed to team B.
--
-- NON-DESTRUCTIVE / additive: existing rows are untouched (assignee_team_id defaults
-- NULL). ADD COLUMN cannot take IF NOT EXISTS in SQLite, so this file is applied exactly
-- once via the migration ledger; the index is IF NOT EXISTS so a re-run is harmless.
ALTER TABLE task_tasks ADD COLUMN assignee_team_id TEXT;
CREATE INDEX IF NOT EXISTS idx_task_tasks_assignee_team ON task_tasks(assignee_team_id, status);
