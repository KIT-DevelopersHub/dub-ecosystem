-- namespace: identity | owner: identity-roster (#3)
-- Additive: 読み仮名（フリガナ）を identity_users に追加。表示名に読み仮名を添え、
-- 五十音ソート / フリガナ検索に使う任意の表示属性。Forward-only・後方互換。
-- Nullable（既存行は NULL のまま）。datetime ではないので theme-3 D2 の
-- DEFAULT 制約には該当しない。D1 は "ADD COLUMN IF NOT EXISTS" を持たないため素の ADD COLUMN。
ALTER TABLE identity_users ADD COLUMN furigana TEXT;
