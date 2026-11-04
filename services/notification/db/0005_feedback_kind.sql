-- notification service (#8) — notif_ namespace, additive slice: inquiry kind on feedback.
-- The ⚙ → 問い合わせ dialog files more than feedback (名刺の追加・友達の招待・面談希望・その他)
-- through the same POST /feedback pipeline; `kind` says which. The existing `category`
-- (bug/idea/question/other) still refines kind='feedback'.
--
-- Non-destructive ADD COLUMN with DEFAULT 'feedback' so every EXISTING row reads as the
-- feedback it was. No CHECK on purpose: SQLite cannot widen a CHECK without a table
-- rebuild (the trap the closed `category` CHECK set), so the vocabulary is validated
-- app-side (notification INQUIRY_KINDS).
ALTER TABLE notif_feedback
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'feedback';
