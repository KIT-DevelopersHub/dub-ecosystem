-- namespace: identity | owner: identity-roster (#3)
-- Per-app access (無効/閲覧/編集) becomes ENFORCED SERVER-SIDE with the policy layer
-- (@dub/types `policy` + @dub/auth-client requireAppAccess). Until now `app:<id>:view` /
-- `app:<id>:edit` only greyed the launcher and guarded routes; writes were still allowed by
-- the DOMAIN key alone (identity:admin 等). identity-roster's 管理 writes and member-service's
-- 運営メンバー / 参加届 writes now ALSO demand the app's `:edit` key, so any role that can write
-- today but is missing that key would start getting 403 — a regression. This migration is
-- the non-breaking backfill that closes exactly that gap, plus two invariant repairs.
--
-- Deliberately NARROW: it touches only the apps whose writes started being enforced. It does
-- NOT re-grant the "open to all" apps (usage / 参加届の閲覧 / Drive共有) to every role, because a
-- role may have had them turned OFF on purpose and re-enabling would undo an admin's choice.
--
-- On "does this override an intentional 閲覧?": before this release, setting 運営メンバー to 閲覧
-- for a role holding identity:admin did NOT actually stop its writes (no server check), so
-- granting `:edit` here PRESERVES today's effective behaviour rather than widening it. From
-- now on the 3 段階 is authoritative, and an admin can set 閲覧 and have it really bite.
--
-- Forward-only + idempotent (INSERT OR IGNORE, driven by SELECT over existing grants so
-- CUSTOM roles are covered too — not just the 4 system roles like 0008/0009). Never edits
-- the frozen 0002 seed (0003–0009 convention).

-- (A) Newly enforced apps: every role that can ALREADY administer identity keeps being able
-- to write in the 管理 (ロール管理 / メール名簿), 運営メンバー and 参加届 apps. Covers custom roles
-- created through ロール管理 after 0008 (which had no per-app backfill of their own).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:admin:view' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:admin:edit' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:members:view' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:members:edit' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:participation:view' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:participation:edit' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
-- 運営メンバー の閲覧は identity:read だけで成立していた(GET は今も identity:read のまま)。
-- 一覧表で「無効」と表示されるのを避けるため、読める役割には view を持たせる。
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:members:view' FROM identity_role_permissions WHERE permission_key = 'identity:read';

-- (B) Invariant repair: `app:<id>:edit` ⇒ `app:<id>:view` (policy.normalizeAppAccessKeys).
-- A role holding only the edit key is ambiguous — the launcher greys the app while the
-- service allows writes. The service now normalises every write, so this fixes legacy rows.
-- One statement per app; the id list is APP_MANIFEST (keep in lockstep when an app is added).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:events:view' FROM identity_role_permissions WHERE permission_key = 'app:events:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:tasks:view' FROM identity_role_permissions WHERE permission_key = 'app:tasks:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:gantt:view' FROM identity_role_permissions WHERE permission_key = 'app:gantt:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:notifications:view' FROM identity_role_permissions WHERE permission_key = 'app:notifications:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:chat:view' FROM identity_role_permissions WHERE permission_key = 'app:chat:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:mail:view' FROM identity_role_permissions WHERE permission_key = 'app:mail:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:usage:view' FROM identity_role_permissions WHERE permission_key = 'app:usage:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:members:view' FROM identity_role_permissions WHERE permission_key = 'app:members:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:participation:view' FROM identity_role_permissions WHERE permission_key = 'app:participation:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:driveshare:view' FROM identity_role_permissions WHERE permission_key = 'app:driveshare:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:lp:view' FROM identity_role_permissions WHERE permission_key = 'app:lp:edit';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'app:admin:view' FROM identity_role_permissions WHERE permission_key = 'app:admin:edit';
