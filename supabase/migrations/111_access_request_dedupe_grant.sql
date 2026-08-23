-- Asking for access has never worked from the catalogue.
--
-- 094 gave catalogue_public INSERT on two columns of catalogue_access_requests
-- and nothing else, which was right for the insert it was written for. The
-- route has since grown a guard so one person asking twice does not bury the
-- staff queue:
--
--   INSERT INTO catalogue_access_requests (instagram_id, note)
--   SELECT $1, $2 WHERE NOT EXISTS (
--     SELECT 1 FROM catalogue_access_requests
--      WHERE instagram_id = $1 AND status = 'pending')
--
-- That subquery READS the table, and a role with INSERT and no SELECT cannot.
-- Every request has come back as "Failed to send request" — a 500 for what is
-- the first thing a stranger ever asks the shop.
--
-- Two columns, and only the two the guard reads. `note` stays unreadable:
-- nothing on this path needs to see what somebody else wrote.
--
-- Re-running is safe.

GRANT SELECT (instagram_id, status)
  ON catalogue_access_requests TO catalogue_public;
