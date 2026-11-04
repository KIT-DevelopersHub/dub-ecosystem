-- commander — Claude session per task (additive). Each task now runs in its own worktree
-- with its own Claude Code session (`--session-id` on the first run, `--resume` after),
-- so a task's runs form one continuous conversation instead of re-sent prompts.
-- Records which session a run belonged to. Nullable, no DEFAULT; NULL = task-less run
-- (Q&A / bundle) or a run from before per-task sessions.

ALTER TABLE commander_runs ADD COLUMN session_id TEXT;
