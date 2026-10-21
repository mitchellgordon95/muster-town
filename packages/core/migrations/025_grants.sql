-- Goal-directed budgets, step 1: grants (a building's proposal / funded ceiling) and their key results.
-- Spend is derived (SUM of sessions.tokens by grantId), so sessions get lane + grantId; buildings get the rollout switch.
CREATE TABLE grants (
  id TEXT PRIMARY KEY, buildingId TEXT NOT NULL, objective TEXT NOT NULL, stopCondition TEXT NOT NULL,
  askTokens INTEGER NOT NULL, grantTokens INTEGER, status TEXT NOT NULL, outcome TEXT,
  findingsDocIds TEXT NOT NULL DEFAULT '[]', checkpointsDone TEXT NOT NULL DEFAULT '[]', checkpointDocId TEXT,
  proposedBy TEXT NOT NULL, fundedBy TEXT, fundedAt TEXT, closedAt TEXT, history TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX grants_building ON grants(buildingId, status);
CREATE TABLE key_results (
  id TEXT PRIMARY KEY, grantId TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, howToCheck TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not-started', statusNote TEXT NOT NULL DEFAULT '', statusBy TEXT, updatedAt TEXT NOT NULL
);
CREATE INDEX key_results_grant ON key_results(grantId, position);
ALTER TABLE sessions ADD COLUMN lane TEXT;
ALTER TABLE sessions ADD COLUMN grantId TEXT;
CREATE INDEX sessions_grant ON sessions(grantId);
ALTER TABLE buildings ADD COLUMN explorationTokensPerDay INTEGER;
ALTER TABLE buildings ADD COLUMN budgetMode TEXT NOT NULL DEFAULT 'open';
