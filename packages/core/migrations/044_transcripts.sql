-- Session transcripts (docs/transcripts.md): the Agent SDK's JSONL for one session, kept so retros can read what an
-- agent actually did. The bytes live as brotli files next to the database (<data>/transcripts/<sessionId>.jsonl.br),
-- not in it: ~200 sessions a day would grow town.db and its nightly backup by gigabytes. Pruned after the retention
-- period (desks.transcriptDays, default 90).
CREATE TABLE IF NOT EXISTS transcripts (
  sessionId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  bytes INTEGER NOT NULL,        -- uncompressed JSONL size
  storedBytes INTEGER NOT NULL,  -- the brotli file's size
  lines INTEGER NOT NULL,
  source TEXT NOT NULL,          -- desk (uploaded by the desk at session end) | host (written by the runtime)
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_created ON transcripts (createdAt);
CREATE INDEX IF NOT EXISTS transcripts_agent ON transcripts (agentId, createdAt);
