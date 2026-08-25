-- namespace: task | owner: task-service (#5).
-- WBS hierarchy + team scope for the gantt read model (北陸ITカンファレンス ガント).
--
-- The prior LMB import flattened the conference gantt: parent/child (work-package →
-- WBS leaf) and team assignment were dropped because task_tasks had no columns for
-- them, so every task rendered as a flat, team-less bar. These three additive,
-- nullable columns restore that structure:
--   team_id   — canonical team.Team id (member_teams). Powers the gantt team filter.
--   parent_id — WBS parent (work-package). gantt-service projects it to the tree.
--   wbs       — WBS code ("4.9.3") for stable ordering + a legible label.
--
-- NON-DESTRUCTIVE / additive: existing rows are untouched (all three default NULL);
-- the frozen CRUD paths keep working. Safe to re-run is NOT guaranteed by ADD COLUMN
-- (it errors if the column exists), so this migration is applied exactly once via the
-- migration ledger.
ALTER TABLE task_tasks ADD COLUMN team_id TEXT;
ALTER TABLE task_tasks ADD COLUMN parent_id TEXT;
ALTER TABLE task_tasks ADD COLUMN wbs TEXT;
CREATE INDEX idx_task_tasks_team ON task_tasks(team_id);
CREATE INDEX idx_task_tasks_parent ON task_tasks(parent_id);
