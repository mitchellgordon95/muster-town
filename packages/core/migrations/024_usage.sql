-- Usage ledger: one row per charge of model usage, counted for the agent's home building.
-- Backfill from the agents' running counters: everything before today at the agent's createdAt (or just before local midnight), today's spend now.
CREATE TABLE usage (id TEXT PRIMARY KEY, agentId TEXT NOT NULL, buildingId TEXT, tokens INTEGER NOT NULL, usd REAL NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
CREATE INDEX usage_building ON usage(buildingId, createdAt);
INSERT INTO usage (id, agentId, buildingId, tokens, usd, createdAt)
  SELECT 'us-backfill-' || id, id, COALESCE(homeBuildingId, buildingId), COALESCE(spentTokensTotal, 0) - COALESCE(spentTokensToday, 0), COALESCE(spentUsdTotal, 0),
    MIN(createdAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'localtime', 'start of day', 'utc', '-1 second'))
  FROM agents WHERE COALESCE(spentTokensTotal, 0) - COALESCE(spentTokensToday, 0) > 0;
INSERT INTO usage (id, agentId, buildingId, tokens, usd, createdAt)
  SELECT 'us-backfill-today-' || id, id, COALESCE(homeBuildingId, buildingId), spentTokensToday, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM agents WHERE COALESCE(spentTokensToday, 0) > 0;
