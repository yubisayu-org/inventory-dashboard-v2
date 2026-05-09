-- Countries table for currency exchange rates and cargo costs.
-- Products reference this to pull current rates when pricing.

CREATE TABLE countries (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  currency      TEXT NOT NULL DEFAULT '',
  kurs          INTEGER NOT NULL DEFAULT 0,
  cargo_per_kg  INTEGER NOT NULL DEFAULT 0
);
