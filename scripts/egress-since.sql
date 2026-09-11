-- What the live code has cost since a reading was taken.
--
--   psql "$DATABASE_URL" -f scripts/egress-since.sql
--
-- Rows are what egress is charged on. Unlike pg_stat_statements read raw, this
-- covers only the period since the snapshot, so it describes the code running
-- now rather than everything that has ever run -- including code deleted
-- months ago, which the raw counters keep forever.
--
-- To take a fresh reading before making changes:
--
--   INSERT INTO perf.stat_snapshots (label, queryid, calls, rows_returned, total_exec_ms, query)
--   SELECT 'before paginating refunds', queryid, calls, rows, total_exec_time, left(query, 400)
--     FROM pg_stat_statements;

\set ON_ERROR_STOP on

-- Both sides are totalled per query first. pg_stat_statements holds one row
-- per (query, user, database), so joining on queryid alone multiplies a query
-- that more than one role runs -- which read as 54 million rows returned in
-- the first zero hours after the snapshot was taken.
WITH base AS (
  SELECT queryid,
         SUM(calls)         AS calls,
         SUM(rows_returned) AS rows,
         MIN(query)         AS query
    FROM perf.stat_snapshots
   WHERE taken_at = (SELECT MAX(taken_at) FROM perf.stat_snapshots)
     AND queryid IS NOT NULL
   GROUP BY queryid
), cur AS (
  SELECT queryid, SUM(calls) AS calls, SUM(rows) AS rows
    FROM pg_stat_statements
   WHERE queryid IS NOT NULL
   GROUP BY queryid
), delta AS (
  SELECT b.query, c.calls - b.calls AS calls, c.rows - b.rows AS rows
    FROM base b JOIN cur c USING (queryid)
   -- A counter that went backwards is a statement evicted and re-entered, or
   -- the collector reset; either way the delta is not a measurement.
   WHERE c.rows >= b.rows
)
SELECT to_char(rows, 'FM999,999,999') AS rows,
       calls,
       CASE WHEN calls > 0 THEN round(rows::numeric / calls) END AS per_call,
       left(regexp_replace(query, '\s+', ' ', 'g'), 70) AS query
  FROM delta
 WHERE rows > 0
 ORDER BY rows DESC
 LIMIT 25;

WITH base AS (
  SELECT queryid, SUM(rows_returned) AS rows
    FROM perf.stat_snapshots
   WHERE taken_at = (SELECT MAX(taken_at) FROM perf.stat_snapshots)
     AND queryid IS NOT NULL
   GROUP BY queryid
), cur AS (
  SELECT queryid, SUM(rows) AS rows FROM pg_stat_statements
   WHERE queryid IS NOT NULL GROUP BY queryid
)
SELECT to_char(SUM(c.rows - b.rows), 'FM999,999,999') AS rows_since_snapshot,
       (SELECT MAX(taken_at)::timestamp(0) FROM perf.stat_snapshots) AS since,
       round(EXTRACT(EPOCH FROM (now() - (SELECT MAX(taken_at) FROM perf.stat_snapshots))) / 3600, 1) AS hours
  FROM base b JOIN cur c USING (queryid)
 WHERE c.rows >= b.rows;
