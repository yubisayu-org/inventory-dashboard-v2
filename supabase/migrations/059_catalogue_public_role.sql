-- Read/write DB role for the PUBLIC, no-login catalogue endpoints
-- (app/api/public/catalogue/*). Scoped so that path can read visible posts
-- and public-safe product fields, and can only insert/read its own
-- customer_handle's rows in catalogue_requests — nothing else.
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

GRANT SELECT, INSERT ON catalogue_requests TO catalogue_public;
GRANT USAGE, SELECT ON catalogue_requests_id_seq TO catalogue_public;
