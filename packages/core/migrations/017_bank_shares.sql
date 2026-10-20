-- Bank step 2: subscription credits expire (no rollover); each building gets a % share; spend is recorded as debits
ALTER TABLE bank_credits ADD COLUMN expiresAt TEXT;
CREATE TABLE bank_shares (buildingId TEXT PRIMARY KEY, pct REAL NOT NULL);
CREATE TABLE bank_debits (id TEXT PRIMARY KEY, buildingId TEXT NOT NULL, agentId TEXT NOT NULL, creditId TEXT, tokens INTEGER NOT NULL, createdAt TEXT NOT NULL);
CREATE INDEX bank_debits_building ON bank_debits(buildingId, creditId);
