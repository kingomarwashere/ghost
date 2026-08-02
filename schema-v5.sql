-- Synced saved places (friends' addresses etc.), tied to a user account.
CREATE TABLE IF NOT EXISTS saved_places (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- 'friend' | (future: 'place')
  name       TEXT NOT NULL,
  sub        TEXT,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  emoji      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);
