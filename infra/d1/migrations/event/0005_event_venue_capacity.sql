-- namespace: event | owner: event-service (#4). Additive (#879): the structured
-- 会場 (venue) and 定員 (capacity) of an event, the source of truth other apps and
-- the AI digest read. Both nullable; existing rows stay untouched (NULL).
-- ADD COLUMN is not re-runnable (it errors if the column exists), so this migration
-- is applied exactly once via the migration ledger.
ALTER TABLE event_events ADD COLUMN venue TEXT;
ALTER TABLE event_events ADD COLUMN capacity INTEGER;
