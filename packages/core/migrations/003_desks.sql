ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'host';
CREATE TABLE interrupts (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, sessionId TEXT, text TEXT NOT NULL, "from" TEXT NOT NULL,
  createdAt TEXT NOT NULL, deliveredAt TEXT
);
CREATE INDEX interrupts_agent ON interrupts(agentId, deliveredAt);
