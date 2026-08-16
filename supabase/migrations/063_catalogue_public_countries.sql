-- Lets the public price-estimate route (app/api/public/catalogue/estimate-price)
-- read a country's real exchange rate and freight rate server-side, to compute
-- an estimate without ever returning those raw numbers to the browser. See
-- docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
--
-- Column-scoped, same idiom as every other catalogue_public grant in this
-- migration series (059, 061) — id/name/currency/kurs/cargo_per_kg only,
-- nothing else on this table, and no other table gains access here.
GRANT SELECT (id, name, currency, kurs, cargo_per_kg) ON countries TO catalogue_public;
