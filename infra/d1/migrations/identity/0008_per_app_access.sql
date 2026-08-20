-- namespace: identity | owner: identity-roster (#3)
-- Additive grant for the PER-APP access tier: app:<id>:view / app:<id>:edit (domain
-- "app", packages/types PERMISSION_CATALOG — now 57 keys). EVERY launcher app gets its
-- OWN graded access pair so an admin can turn each app on/off for a role INDIVIDUALLY,
-- even apps that historically rode a SHARED domain key (gantt rode task:read alongside
-- マイタスク; 参加届 rode identity:read alongside 運営メンバー). The shell launcher greys + the
-- route guard 403s an app whose app:<id>:view a role lacks, so this migration is the
-- non-breaking backfill: each system role is granted exactly the per-app keys equivalent
-- to what it can ALREADY reach today (view = can open the app / open-to-all app; edit =
-- currently holds the app's write perm). admin holds ALL per-app keys (super-admin
-- invariant, seed.test.ts). Mirrors identity-roster seed.ts computeAppAccessKeys — keep in
-- lockstep. Forward-only + idempotent via INSERT OR IGNORE; never edits the frozen 0002
-- seed (no ledger drift, per the 0003–0007 convention).

-- admin: every app, both tiers (the whole per-app catalog).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:events:view'),('role_sys_admin','app:events:edit'),
  ('role_sys_admin','app:tasks:view'),('role_sys_admin','app:tasks:edit'),
  ('role_sys_admin','app:gantt:view'),('role_sys_admin','app:gantt:edit'),
  ('role_sys_admin','app:notifications:view'),('role_sys_admin','app:notifications:edit'),
  ('role_sys_admin','app:chat:view'),('role_sys_admin','app:chat:edit'),
  ('role_sys_admin','app:mail:view'),('role_sys_admin','app:mail:edit'),
  ('role_sys_admin','app:usage:view'),('role_sys_admin','app:usage:edit'),
  ('role_sys_admin','app:members:view'),('role_sys_admin','app:members:edit'),
  ('role_sys_admin','app:participation:view'),('role_sys_admin','app:participation:edit'),
  ('role_sys_admin','app:driveshare:view'),('role_sys_admin','app:driveshare:edit'),
  ('role_sys_admin','app:admin:view'),('role_sys_admin','app:admin:edit');

-- maintainer: full operational reach; edit where it holds the write perm. No 管理 app
-- (no identity:admin); members/participation view-only (cannot administer identity).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_maintainer','app:events:view'),('role_sys_maintainer','app:events:edit'),
  ('role_sys_maintainer','app:tasks:view'),('role_sys_maintainer','app:tasks:edit'),
  ('role_sys_maintainer','app:gantt:view'),('role_sys_maintainer','app:gantt:edit'),
  ('role_sys_maintainer','app:notifications:view'),
  ('role_sys_maintainer','app:chat:view'),('role_sys_maintainer','app:chat:edit'),
  ('role_sys_maintainer','app:mail:view'),('role_sys_maintainer','app:mail:edit'),
  ('role_sys_maintainer','app:usage:view'),
  ('role_sys_maintainer','app:members:view'),
  ('role_sys_maintainer','app:participation:view'),
  ('role_sys_maintainer','app:driveshare:view'),('role_sys_maintainer','app:driveshare:edit');

-- organizer: events/tasks/gantt edit; chat/usage/members/participation/driveshare view;
-- notifications view. No mail (no mail:read), no 管理.
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_organizer','app:events:view'),('role_sys_organizer','app:events:edit'),
  ('role_sys_organizer','app:tasks:view'),('role_sys_organizer','app:tasks:edit'),
  ('role_sys_organizer','app:gantt:view'),('role_sys_organizer','app:gantt:edit'),
  ('role_sys_organizer','app:notifications:view'),
  ('role_sys_organizer','app:chat:view'),
  ('role_sys_organizer','app:usage:view'),
  ('role_sys_organizer','app:members:view'),
  ('role_sys_organizer','app:participation:view'),
  ('role_sys_organizer','app:driveshare:view');

-- member: tasks/gantt edit (holds task:write); events/notifications/chat/usage/members/
-- participation/driveshare view. No mail, no 管理.
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_member','app:events:view'),
  ('role_sys_member','app:tasks:view'),('role_sys_member','app:tasks:edit'),
  ('role_sys_member','app:gantt:view'),('role_sys_member','app:gantt:edit'),
  ('role_sys_member','app:notifications:view'),
  ('role_sys_member','app:chat:view'),
  ('role_sys_member','app:usage:view'),
  ('role_sys_member','app:members:view'),
  ('role_sys_member','app:participation:view'),
  ('role_sys_member','app:driveshare:view');
