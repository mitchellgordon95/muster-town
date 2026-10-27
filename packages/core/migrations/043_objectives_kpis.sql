-- Objectives and KPIs (Mitchell and Pix, 1:1 mt_akz25kqo2q, decisions 3 and 4; design docs/goal-directed-budgets.md).
-- A building goal holds 2-3 objectives (one sentence, a quarter horizon, the town KPI it moves); key results hang off an
-- objective. Additive: existing key results keep objectiveId null ("Unsorted") with their ids, statuses and grants.
CREATE TABLE objectives (
  id TEXT PRIMARY KEY, buildingId TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, horizon TEXT NOT NULL,
  kpiId TEXT, createdBy TEXT, editedBy TEXT, sourceDocIds TEXT NOT NULL DEFAULT '[]', updatedAt TEXT NOT NULL
);
CREATE INDEX objectives_building ON objectives(buildingId, position);
ALTER TABLE key_results ADD COLUMN objectiveId TEXT;
-- Standing town indicators, never met or missed; their values are computed live (core/src/kpis.ts), never typed in.
CREATE TABLE kpis (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'town', key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, measure TEXT NOT NULL,
  position INTEGER NOT NULL
);
INSERT INTO kpis (id, scope, key, name, measure, position) VALUES
  ('kpi_fund', 'town', 'fund', 'Fund', 'Funders other than the owner: distinct humans who funded a grant or added a Bank input in the week, and the tokens they put in.', 0),
  ('kpi_join', 'town', 'join', 'Join', 'Strangers who came back: humans (not the owner) whose first activity fell in the week and who were active again on a later day within 14 days.', 1),
  ('kpi_trust', 'town', 'trust', 'Trust', 'Humans (not the owner) who staked something a second time: answered an outbox request, or funded a grant after having funded one before.', 2);
