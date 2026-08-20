-- namespace: task | owner: task-service (#5).
-- Cross-scope dependencies (ADR-0006): a task's owning TEAM becomes the dependency
-- boundary. Same-team tasks may depend across different WBS scopes (別階層); cross-team
-- links are rejected (they go through the request/approval flow). The dependency门番 in
-- task-service compares task_tasks.team_id, so the column must be persisted here.
--
-- ADDITIVE / NON-DESTRUCTIVE: a nullable column with no default. Every existing row keeps
-- team_id = NULL (the "no team" bucket), so pre-existing dependencies stay valid (two
-- team-less tasks may still depend — back-compat). No rebuild, no data loss.
ALTER TABLE task_tasks ADD COLUMN team_id TEXT;

-- Team-scoped views/filters read tasks by team; index the new column (partial: live rows).
CREATE INDEX idx_task_tasks_team ON task_tasks(team_id) WHERE archived_at IS NULL;
