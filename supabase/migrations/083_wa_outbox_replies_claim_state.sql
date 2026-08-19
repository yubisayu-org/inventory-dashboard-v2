-- Neither wa_outbox nor wa_replies is polled atomically: worker/index.ts
-- runs a setInterval sweep over each table, and the "pick the next pending
-- row" query (nextPending/nextPendingSend/nextPendingReply) was a plain
-- SELECT with no FOR UPDATE SKIP LOCKED and no transitional state. If one
-- sweep's async body outlives its own interval tick (a hung sendMessage
-- call, a slow network), the next tick starts a second, overlapping sweep
-- that can pick up and re-send the SAME row — the same ✅ reaction or
-- "Sudah dicatat" text goes out twice, or the same photo re-posts.
--
-- A 'sending' intermediate state, claimed via an atomic
-- UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED), closes that:
-- two concurrent sweeps can never both walk away with the same row, since
-- the second sweep's SELECT ... FOR UPDATE SKIP LOCKED simply skips a row
-- the first sweep already locked and is mid-claiming.
ALTER TABLE wa_outbox DROP CONSTRAINT wa_outbox_state_check;
ALTER TABLE wa_outbox ADD CONSTRAINT wa_outbox_state_check
  CHECK (state IN ('pending', 'sending', 'sent', 'failed'));

ALTER TABLE wa_replies DROP CONSTRAINT wa_replies_state_check;
ALTER TABLE wa_replies ADD CONSTRAINT wa_replies_state_check
  CHECK (state IN ('pending', 'sending', 'sent', 'failed'));
