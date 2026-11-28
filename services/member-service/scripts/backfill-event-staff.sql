-- One-off backfill for 0029_event_staff (運営メンバー per event). NOT a migration: run it
-- by hand on prod AFTER 0029 is applied. Idempotent (ON CONFLICT DO NOTHING) — re-running
-- adds nothing twice and never removes a row someone chose in the UI.
--
-- 北陸ITカンファレンス 2027 (acd75449-c875-4c13-83d8-2dd8f8ce8a33): the whole current roster
-- and every current 班.
INSERT INTO member_event_people (event_id, person_id, added_by, added_at)
  SELECT 'acd75449-c875-4c13-83d8-2dd8f8ce8a33', id, 'system:backfill', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM member_people
   WHERE archived_at IS NULL
  ON CONFLICT (event_id, person_id) DO NOTHING;
INSERT INTO member_event_teams (event_id, team_id, added_by, added_at)
  SELECT 'acd75449-c875-4c13-83d8-2dd8f8ce8a33', id, 'system:backfill', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM member_teams
   WHERE true -- (SQLite: an INSERT ... SELECT needs a WHERE before ON CONFLICT)
  ON CONFLICT (event_id, team_id) DO NOTHING;

-- miniconference (event_01M8C4ZK8020EFG6KYFT7S5B2N): these 5 login accounts, mapped to
-- their roster rows through member_people.identity_user_id, plus the 班 they belong to.
INSERT INTO member_event_people (event_id, person_id, added_by, added_at)
  SELECT 'event_01M8C4ZK8020EFG6KYFT7S5B2N', id, 'system:backfill', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM member_people
   WHERE archived_at IS NULL
     AND identity_user_id IN (
       'user_01KZRTAHRTPF9MHN92CTSD5X01',
       'user_01M4TYVCFAR6J4N3Y54PWY132W',
       'user_01KZRTAHQRXSHC4ZCCA1EDXPWY',
       'user_01M4YYW8DNHX3JNX2W3MT2FZRZ',
       'user_01KZRTAHMGB7JG691GPF7YRQ0R'
     )
  ON CONFLICT (event_id, person_id) DO NOTHING;
INSERT INTO member_event_teams (event_id, team_id, added_by, added_at)
  SELECT DISTINCT 'event_01M8C4ZK8020EFG6KYFT7S5B2N', l.team_id, 'system:backfill', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM member_team_links l
    JOIN member_event_people e ON e.person_id = l.person_id
   WHERE e.event_id = 'event_01M8C4ZK8020EFG6KYFT7S5B2N'
  ON CONFLICT (event_id, team_id) DO NOTHING;
