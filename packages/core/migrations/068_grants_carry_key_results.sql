-- Build steps 4-5 of docs/how-work-gets-done.md (§4, 1:1 mt_wql34b8gkl): key results merge into grants. A grant is
-- filed against a goal (grants.goalId) and carries 1-5 key results (key_results.grantId); goals keep none of their own.
-- Additive columns; it rewrites live data: open key results with no open grant are archived as "dropped" (their text
-- stays on the goal as history), and an open grant's testing plan lines become key results after its first.

ALTER TABLE grants ADD COLUMN goalId TEXT;
ALTER TABLE key_results ADD COLUMN grantId TEXT;
CREATE INDEX key_results_grant_owner ON key_results(grantId, position);

-- a grant's goal: its key result's goal, else its building's
UPDATE grants SET goalId = COALESCE(
  (SELECT k.goalId FROM key_results k WHERE k.id = grants.keyResultId),
  (SELECT b.goalId FROM buildings b WHERE b.id = grants.buildingId));

-- a key result belongs to the grant that names it: an open grant first, else the latest
UPDATE key_results SET grantId = (
  SELECT g.id FROM grants g WHERE g.keyResultId = key_results.id
  ORDER BY CASE WHEN g.status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint') THEN 0 ELSE 1 END, g.createdAt DESC, g.rowid DESC
  LIMIT 1);

-- an open grant's testing plan lines become its key results (undated), after its first
INSERT INTO key_results (id, buildingId, position, text, howToCheck, status, statusNote, updatedAt, sourceDocIds, goalId, grantId)
  SELECT 'kr_' || lower(hex(randomblob(5))), g.buildingId,
    (SELECT COALESCE(MAX(position), 0) FROM key_results) + 1 + t.key + g.rowid * 10,
    substr(json_extract(t.value, '$.text'), 1, 300), substr(json_extract(t.value, '$.howToCheck'), 1, 300),
    'not-started', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '[]', g.goalId, g.id
  FROM grants g, json_each(g.testingPlan) t
  WHERE g.status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint') AND g.testingPlan != '[]';
UPDATE grants SET testingPlan = '[]' WHERE status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint');

-- an open grant with no key result at all names its first one now (the objective, checked by its stop condition)
INSERT INTO key_results (id, buildingId, position, text, howToCheck, status, statusNote, updatedAt, sourceDocIds, goalId, grantId)
  SELECT 'kr_' || lower(hex(randomblob(5))), g.buildingId, (SELECT COALESCE(MAX(position), 0) FROM key_results) + 1 + g.rowid,
    substr(g.objective, 1, 300), substr(g.stopCondition, 1, 300), 'not-started', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '[]', g.goalId, g.id
  FROM grants g
  WHERE g.status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint')
    AND NOT EXISTS (SELECT 1 FROM key_results k WHERE k.grantId = g.id);
UPDATE grants SET keyResultId = (SELECT k.id FROM key_results k WHERE k.grantId = grants.id ORDER BY position, rowid LIMIT 1)
  WHERE keyResultId IS NULL AND status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint');

-- goals keep no open key results: one with no open grant is dropped (archived, its text kept as history)
UPDATE key_results SET archivedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    statusNote = 'dropped when key results merged into grants (docs/how-work-gets-done.md §4)'
  WHERE archivedAt IS NULL AND status NOT IN ('met', 'missed')
    AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.id = key_results.grantId AND g.status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint'));

-- work that named a dropped key result keeps its words as its gap
UPDATE assignments SET gap = COALESCE(gap, substr((SELECT text FROM key_results k WHERE k.id = assignments.keyResultId), 1, 300)), keyResultId = NULL
  WHERE keyResultId IS NOT NULL AND lane IN ('exploration', 'directed') AND status IN ('pending', 'active');
