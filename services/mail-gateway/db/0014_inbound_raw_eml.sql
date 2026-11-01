-- mail-gateway (データ保全 Phase 1) — the full raw .eml of every received message in R2.
-- Mirror of services/mail-gateway/db/0014_inbound_raw_eml.sql (kept byte-identical; infra
-- is the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only; extends mail_inbound (0001) with one nullable column.
--   raw_r2_key : R2 key (bucket dub-mail-attachments) of the untruncated RFC822 bytes,
--                `raw/<yyyy>/<mm>/<mail_inbound.id>.eml`. NULL = R2 not bound, the put
--                failed (ingest never fails on it), or a pre-0014 row. Lets a parser bug
--                or a data-loss incident be repaired by re-parsing the original message.
ALTER TABLE mail_inbound ADD COLUMN raw_r2_key TEXT;
