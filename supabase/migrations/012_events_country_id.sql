-- Add country_id to events table.
-- NULL = domestic event, non-NULL = abroad event linked to a country.

ALTER TABLE events ADD COLUMN country_id INTEGER REFERENCES countries(id) ON DELETE RESTRICT;
