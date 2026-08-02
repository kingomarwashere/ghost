-- Schema v8: optional photo for saved people/contacts.
-- Stored as a small (~160px) JPEG data URL right on the row, synced per user.
ALTER TABLE saved_places ADD COLUMN photo TEXT;
