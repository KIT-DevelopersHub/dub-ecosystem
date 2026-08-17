-- namespace: member | owner: member-service (参加届: 氏名のローマ字/アルファベット表記)
-- Additive, non-destructive: a 参加届 now also captures the 氏名 in ローマ字 as SEPARATE
-- 姓 (last) / 名 (first) fields. これはアルファベットのメールアドレス発行 (例
-- first.last@) の候補生成に使う。任意フィールド (英字) なので nullable。既存行は保持し
-- NULL 許容カラムを足すだけ。Retained on the resolved 運営メンバー (member_people) too so
-- the roster keeps the alphabet name for address issuance.
ALTER TABLE member_participations ADD COLUMN last_name_romaji TEXT;
ALTER TABLE member_participations ADD COLUMN first_name_romaji TEXT;
ALTER TABLE member_people ADD COLUMN last_name_romaji TEXT;
ALTER TABLE member_people ADD COLUMN first_name_romaji TEXT;
