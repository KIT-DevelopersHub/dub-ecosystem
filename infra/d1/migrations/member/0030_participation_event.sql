-- namespace: member | owner: member-service. Additive: the event a 参加届 was submitted for.
-- The public form carries it (/participate?event=<id>); when an admin reflects the 届 into
-- the roster, the person also joins that event's 運営メンバー (member_event_people, 0029).
-- NULL = 旧フォーム・イベント指定なし (existing rows stay NULL; nothing is rewritten).
ALTER TABLE member_participations ADD COLUMN event_id TEXT;
