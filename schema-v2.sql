-- Schema v2 migration — adds direction column + report_history table

-- Add direction column to cameras (stores bearing 0-359 that camera faces)
ALTER TABLE cameras ADD COLUMN direction INTEGER;

-- Report history — never expires, used for heatmap
CREATE TABLE IF NOT EXISTS report_history (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_history_bounds ON report_history(lat, lng);
CREATE INDEX IF NOT EXISTS idx_report_history_time ON report_history(created_at);
