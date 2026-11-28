-- #907 確認用のデモデータ（staging2 の dub-core-staging2 専用）。本番には当てない。
-- 追加だけ（INSERT OR IGNORE・新しい行の id は demo_ 始まり）。既存の行は消さない・書き換えない。
-- 何度当てても増えない。前提: event 0007 / member 0029・0030 が当たっていること。
--
-- イベント
--   event_01SEED000000000000000CONF0 (既存「Hokuriku IT Conference 2026」) = 既定＋運営メンバー / 在籍中の全員・全班
--   demo_evt_teirei 運営定例ミーティング = 既定のみ（イベント・ガントチャート・ロール管理）/ 0 人
--   demo_evt_hackit 学生ハッカソン Hackit 秋 = 設定なし（全部オン）/ 7 人・3 班

INSERT OR IGNORE INTO event_events (id, org_id, title, description, phase, starts_at, ends_at, version, archived_at, created_by, created_at, updated_at, venue, capacity) VALUES
  ('demo_evt_teirei', 'org_devhub', '運営定例ミーティング', '毎週の運営定例。進捗共有と次アクションの確認を行う。', 'planning', '2026-12-08T09:00:00.000Z', '2026-12-08T10:00:00.000Z', 1, NULL, 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z', '2026-11-29T00:00:00.000Z', 'オンライン', NULL),
  ('demo_evt_hackit', 'org_devhub', '学生ハッカソン Hackit 秋', '学生向けハッカソン。会場・協賛・募集・当日運営を進める。', 'open', '2026-12-19T00:00:00.000Z', '2026-12-20T09:00:00.000Z', 1, NULL, 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z', '2026-11-29T00:00:00.000Z', '金沢工業大学', 80);

INSERT OR IGNORE INTO event_actions (id, event_id, kind, title, sort_order, version, archived_at, created_by, created_at, updated_at) VALUES
  ('demo_act_teirei_agenda', 'demo_evt_teirei', 'announcement', '定例アジェンダ共有', 0, 1, NULL, 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z', '2026-11-29T00:00:00.000Z'),
  ('demo_act_hackit_venue', 'demo_evt_hackit', 'venue', 'Hackit: 会場・日程確定', 0, 1, NULL, 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z', '2026-11-29T00:00:00.000Z'),
  ('demo_act_hackit_sponsor', 'demo_evt_hackit', 'sponsor', 'Hackit: 協賛・賞品調整', 1, 1, NULL, 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z', '2026-11-29T00:00:00.000Z');

-- 使うアプリ（Hackit は行なし = 全部オン）
INSERT OR IGNORE INTO event_event_apps (event_id, apps, updated_by, updated_at) VALUES
  ('event_01SEED000000000000000CONF0', '["events","gantt","members","admin"]', 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z'),
  ('demo_evt_teirei', '["events","gantt","admin"]', 'user_01SEED000000000000000ADMIN', '2026-11-29T00:00:00.000Z');

-- 北陸ITカンファレンス 2026（既存イベント）: 在籍中の全員と全部の班
INSERT OR IGNORE INTO member_event_people (event_id, person_id, added_by, added_at)
  SELECT 'event_01SEED000000000000000CONF0', id, 'system:seed-907', '2026-11-29T00:00:00.000Z'
    FROM member_people WHERE archived_at IS NULL;
INSERT OR IGNORE INTO member_event_teams (event_id, team_id, added_by, added_at)
  SELECT 'event_01SEED000000000000000CONF0', id, 'system:seed-907', '2026-11-29T00:00:00.000Z'
    FROM member_teams;

-- Hackit 秋: 7 人（6 人はアカウントあり・高岡 己太朗 はアカウントなし）と 3 班
INSERT OR IGNORE INTO member_event_people (event_id, person_id, added_by, added_at)
  SELECT 'demo_evt_hackit', id, 'system:seed-907', '2026-11-29T00:00:00.000Z'
    FROM member_people
   WHERE archived_at IS NULL AND id IN (
     'member_p1',
     'seed1126_mp_lead_dev',
     'seed1126_mp_lead_pr',
     'seed1126_mp_mem_dev1',
     'seed1126_mp_mem_dev2',
     'seed1126_mp_mem_ops1',
     'seed1126_mp_mem_pr1'
   );
INSERT OR IGNORE INTO member_event_teams (event_id, team_id, added_by, added_at)
  SELECT 'demo_evt_hackit', id, 'system:seed-907', '2026-11-29T00:00:00.000Z'
    FROM member_teams WHERE id IN ('member_team_dev', 'member_team_ops', 'member_team_pr');

-- 参加届（イベント付き）。未反映 2 件は「追加する」でそのイベントの運営名簿に入る確認用
INSERT OR IGNORE INTO member_participations (id, org_id, member_id, name, normalized_name, name_kana, grade, department, contact, desired_team_id, desired_activity, note, status, match_kind, submitted_by, submitted_at, created_at, updated_at, school_email, gmail, last_name, first_name, last_name_kana, first_name_kana, review_state, event_id) VALUES
  ('demo_part_teirei_mori', 'org_devhub', NULL, '森 結菜', '森結菜', 'もり ゆいな', '2', '情報工学科', 'mori@example.com', 'member_team_ops', NULL, NULL, 'submitted', 'created_new', 'system:public-participation', '2026-11-28T10:00:00.000Z', '2026-11-28T10:00:00.000Z', '2026-11-28T10:00:00.000Z', 'mori@example.com', 'mori.demo@example.com', '森', '結菜', 'もり', 'ゆいな', 'pending', 'demo_evt_teirei'),
  ('demo_part_hackit_ishida', 'org_devhub', NULL, '石田 陽翔', '石田陽翔', 'いしだ はると', '1', 'メディア情報学科', 'ishida@example.com', 'member_team_dev', NULL, NULL, 'submitted', 'created_new', 'system:public-participation', '2026-11-28T10:05:00.000Z', '2026-11-28T10:05:00.000Z', '2026-11-28T10:05:00.000Z', 'ishida@example.com', 'ishida.demo@example.com', '石田', '陽翔', 'いしだ', 'はると', 'pending', 'demo_evt_hackit'),
  ('demo_part_conf_aikawa', 'org_devhub', 'seed1126_mp_org1', '相川 遥斗', '相川遥斗', 'あいかわ はると', '3', '情報工学科', 'org1@seed1126.example.invalid', 'member_team_hq', NULL, NULL, 'submitted', 'linked_existing', 'system:public-participation', '2026-11-27T09:00:00.000Z', '2026-11-27T09:00:00.000Z', '2026-11-27T09:00:00.000Z', 'org1@seed1126.example.invalid', NULL, '相川', '遥斗', 'あいかわ', 'はると', 'added', 'event_01SEED000000000000000CONF0');
