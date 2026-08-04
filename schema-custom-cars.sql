-- Custom vehicles pushed in from other Radical apps (Chisel "Send to Ghost").
-- GLB lives in R2 (custom-cars/<id>.glb); this row drives the fleet listing.
CREATE TABLE IF NOT EXISTS custom_cars (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  emoji      TEXT,
  size       INTEGER,
  created_at INTEGER NOT NULL
);
