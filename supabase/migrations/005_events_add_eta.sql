-- Add ETA column to events table.

ALTER TABLE events ADD COLUMN eta TEXT NOT NULL DEFAULT '';
