-- A place to keep readings of pg_stat_statements, so egress can be measured
-- over a window instead of averaged over the life of the counters.
--
-- The counters are cumulative and were last reset on 22 May 2026. That makes
-- them unable to answer the only question worth asking after a day of
-- optimisation -- "what does the current code cost?" -- and actively
-- misleading about the past: on 11 Sep the top of the list still showed
-- full-table reads of products and payments, both of which were paginated in
-- late May, a fortnight into the window. They will sit there forever.
--
-- Resetting the counters would answer the question and destroy the history, so
-- instead a reading is copied here and later readings are subtracted from it.
--
-- Applied by hand with psql, like every migration on this project -- see the
-- note in 100 about the ledger.

CREATE SCHEMA IF NOT EXISTS perf;

CREATE TABLE IF NOT EXISTS perf.stat_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- What was true when it was taken, in words: "after the egress work",
  -- "before paginating refunds". A diff is only meaningful against a label.
  label         TEXT        NOT NULL,
  queryid       BIGINT,
  calls         BIGINT      NOT NULL,
  rows_returned BIGINT      NOT NULL,
  total_exec_ms DOUBLE PRECISION NOT NULL,
  -- Truncated: the shape identifies the query, and some of ours are 4KB of
  -- CTEs that nobody will read from a diff.
  query         TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS stat_snapshots_taken_idx ON perf.stat_snapshots (taken_at);
CREATE INDEX IF NOT EXISTS stat_snapshots_queryid_idx ON perf.stat_snapshots (queryid);

-- How to read one later:
--
--   SELECT s.query, cur.calls - s.calls AS calls,
--          cur.rows - s.rows_returned   AS rows
--     FROM perf.stat_snapshots s
--     JOIN pg_stat_statements cur USING (queryid)
--    WHERE s.label = 'after the egress work, 11 Sep 2026'
--    ORDER BY 3 DESC LIMIT 20;
--
-- Rows in that answer are what the live code has returned since the reading,
-- which is the number egress is charged on.
