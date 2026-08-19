-- wa_replies needs the customer's own number to build a correctly-quoting
-- synthetic message key. worker/replies.ts (sendNextReply) and
-- worker/product-post-offer.ts (askDisambiguation) both build a quoted-
-- message key of the shape { remoteJid: groupJid, id, fromMe: false } with
-- no `participant` — per Baileys' own quoting logic, a key with no
-- participant falls back to using remoteJid (the GROUP's jid) as the quote's
-- participant, so the rendered quote would show the wrong person. The real
-- number is known at queue time (catalogue_requests.sender) but wa_replies
-- had nowhere to carry it through to the worker.
ALTER TABLE wa_replies ADD COLUMN participant TEXT NOT NULL DEFAULT '';
