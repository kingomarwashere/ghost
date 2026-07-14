CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT NOT NULL DEFAULT 'police',
  description TEXT,
  confirms INTEGER DEFAULT 0,
  denies INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reporter_hash TEXT
);

CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT,
  state TEXT,
  road TEXT,
  speed_limit INTEGER,
  external_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_bounds ON reports(lat, lng);
CREATE INDEX IF NOT EXISTS idx_reports_expires ON reports(expires_at);
CREATE INDEX IF NOT EXISTS idx_cameras_bounds ON cameras(lat, lng);
CREATE INDEX IF NOT EXISTS idx_cameras_type ON cameras(type);
