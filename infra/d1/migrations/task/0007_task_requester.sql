-- namespace: task | owner: task-service (#5).
-- 依頼者 (requester) を任意で設定・変更できる値にする (#881 / オーナー決定:
-- 「依頼者は必須ではないが、設定できる値にしよう。依頼者がいる場合は、その人も編集できる」)。
--
-- これまで依頼者 = created_by (作成者・変更不可・NOT NULL) だった (マイタスクの「誰から誰へ」
-- の「から」、依頼レンズ)。requester_id を別に持ち、作成時の既定は作成者・後から変更/解除できる。
-- 既存行は今の表示と矛盾しないよう created_by を写す。
-- 番号 0007: 0006 は #882 (0006_task_assignee_team) が使う。
--
-- NON-DESTRUCTIVE / additive. ADD COLUMN は IF NOT EXISTS が使えず再実行でエラーになるので、
-- 本番/staging に当てる前に列が無いことを確認すること:
--   SELECT COUNT(*) FROM pragma_table_info('task_tasks') WHERE name = 'requester_id';  -- 0 なら当てる
-- 下の UPDATE は requester_id IS NULL の行だけ埋める (当てた直後の 1 回きり。後から依頼者を
-- 解除した行を埋め戻さないよう、再実行はしない)。
ALTER TABLE task_tasks ADD COLUMN requester_id TEXT;
UPDATE task_tasks SET requester_id = created_by WHERE requester_id IS NULL;
