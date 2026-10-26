-- Off-site backup (grant gr_jkorz4f49a, deploy/README.md "Backups"): the one row the nightly job keeps about its last
-- copy, read back by GET /api/health `backup`. Never the key or the bucket credentials: those stay in the server's env.
CREATE TABLE IF NOT EXISTS backup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lastAt TEXT,            -- ISO time of the last successful upload
  bytes INTEGER,          -- size of the uploaded object (gzip + AES-GCM)
  key TEXT,               -- the object key, e.g. town/2026-10-27.db.gz.enc
  error TEXT,             -- the last failure's message (cleared by the next success)
  errorAt TEXT
);
INSERT OR IGNORE INTO backup_state (id) VALUES (1);
