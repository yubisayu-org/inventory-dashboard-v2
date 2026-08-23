-- The customer's marked-up shelf reply was previously discarded once its
-- claim was recorded (kept only under WA_DEBUG). Path to a compressed copy
-- kept in the wa-posts bucket (private, same as shelf posts — see
-- lib/storage.ts's "anything annotated stays in the private bucket") so a
-- disputed claim has the actual photo to point to, not just the parsed
-- position.
ALTER TABLE wa_claims ADD COLUMN reply_image_path text;
