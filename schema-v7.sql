-- Schema v7: per-user preferences synced across devices (emoji/icon overrides).
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    TEXT PRIMARY KEY,
  icons      TEXT,              -- JSON map of key -> emoji override
  updated_at INTEGER NOT NULL
);
