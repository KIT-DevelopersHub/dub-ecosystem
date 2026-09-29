-- commander (P1-2) — artifact URL columns on commander_tasks (additive).
-- A task's run output (demo/staging deploy, PR) is auto-extracted from the run event
-- stream (services/commander-service/src/urls.ts) and stored here so the operator can
-- click straight through from a board card / the drawer's 成果物 tab to confirm the work.
-- All nullable, no DEFAULT (theme3 D2 bans DDL DEFAULTs); "no URL yet" = NULL.
-- Additive only: never rewrites the SoT — existing rows keep working (columns read NULL).

ALTER TABLE commander_tasks ADD COLUMN demo_url TEXT;
ALTER TABLE commander_tasks ADD COLUMN staging_url TEXT;
ALTER TABLE commander_tasks ADD COLUMN pr_url TEXT;
