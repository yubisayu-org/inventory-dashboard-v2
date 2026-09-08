-- Bound how long a single statement, or an abandoned transaction, may hold a
-- connection -- on the server, where the pooler cannot drop it.
--
-- The driver already asks for a 15s statement_timeout in lib/db-pool.ts, and
-- production never received it: Supavisor does not pass a client's connection
-- parameters through to the server connections it hands out. Asked through the
-- app's own pool, the session answers:
--
--     SHOW statement_timeout  ->  2min
--
-- which is Supabase's default, not ours. A role-level setting is applied by the
-- server itself when the backend starts, so it survives transaction pooling.
--
-- What this does NOT fix: the 8 Sep 2026 outage, where sixteen backends sat for
-- thirteen minutes blocked writing results to app processes a deploy had
-- killed. Those had finished executing, and statement_timeout does not fire
-- while a backend is blocked handing results back. Closing the pools on SIGTERM
-- (instrumentation.ts) is what prevents those. This is the other half: a query
-- that genuinely runs long stops being able to hold a connection all day.
--
-- Applied by hand with psql, like every migration on this project -- see the
-- note in 100 about the ledger.

-- The dashboard's own role. Generous, because it also runs migrations and index
-- builds: a maintenance session that needs longer says so explicitly with
-- `SET statement_timeout = 0` before it starts.
ALTER ROLE postgres SET statement_timeout = '60s';
ALTER ROLE postgres SET idle_in_transaction_session_timeout = '60s';

-- The customer site. Nothing it does is allowed to be slow: the catalogue gives
-- up on its own requests after 12 seconds, so a query still running at twenty
-- is answering a page nobody is waiting for any more.
ALTER ROLE catalogue_public SET statement_timeout = '20s';
ALTER ROLE catalogue_public SET idle_in_transaction_session_timeout = '30s';

-- The invoice site, which only ever reads.
ALTER ROLE invoice_reader SET statement_timeout = '20s';
ALTER ROLE invoice_reader SET idle_in_transaction_session_timeout = '30s';
