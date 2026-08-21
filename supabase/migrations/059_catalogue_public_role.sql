-- Read/write DB role for the PUBLIC, no-login catalogue endpoints
-- (app/api/public/catalogue/*). Column grants keep it off cost/profit fields
-- on products and restrict its catalogue_requests INSERT to the columns a
-- public request can legitimately set. There is no RLS here: visibility of
-- catalogue_posts and per-customer_handle scoping of catalogue_requests are
-- enforced in the API routes' WHERE clauses, not by these grants — this role
-- can SELECT every row in catalogue_requests and every visible post.
--
-- IMPORTANT: set a real password out-of-band (do NOT commit it), then point
-- CATALOGUE_PUBLIC_DATABASE_URL at this role:
--   ALTER ROLE catalogue_public WITH PASSWORD '<strong-secret>';
-- Connect via the Supabase pooler as `catalogue_public.<project-ref>`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalogue_public') THEN
    CREATE ROLE catalogue_public LOGIN PASSWORD 'CHANGE_ME_BEFORE_USE'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM catalogue_public;
GRANT USAGE ON SCHEMA public TO catalogue_public;

GRANT SELECT ON catalogue_posts, catalogue_post_products TO catalogue_public;

-- Public-safe columns only — no cost, profit, or internal pricing fields.
GRANT SELECT (id, name, store, price) ON products TO catalogue_public;

GRANT SELECT ON catalogue_requests TO catalogue_public;
GRANT INSERT (customer_handle, product_id, qty, note) ON catalogue_requests TO catalogue_public;
GRANT USAGE, SELECT ON catalogue_requests_id_seq TO catalogue_public;
