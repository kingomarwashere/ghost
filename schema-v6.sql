-- Schema v6: user car requests (shown in the admin dashboard).
CREATE TABLE IF NOT EXISTS car_requests (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,              -- null when requested anonymously
  car_name   TEXT NOT NULL,
  color      TEXT,
  notes      TEXT,
  status     TEXT DEFAULT 'pending',   -- 'pending' | 'added' | 'rejected'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_car_requests_time   ON car_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_car_requests_status ON car_requests(status);
