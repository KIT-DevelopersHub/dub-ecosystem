-- commander — every PR a task produced (additive). pr_url keeps only the latest; a task
-- often spans several PRs (split PRs, re-submits), so the drawer lists all of them.
-- JSON array of PR URLs in first-seen order. Nullable, no DEFAULT; NULL = none yet.

ALTER TABLE commander_tasks ADD COLUMN pr_urls TEXT;
