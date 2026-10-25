-- Key results move onto the building goal (Mitchell, 1:1 dc_bo7xuobtbv): a human writes them; a grant names exactly one
-- (keyResultId) and carries the plan (objective, approach, stop condition, ask) plus an optional testing plan, which is
-- what used to be the grant's own key results (text + howToCheck, no status). Every old key result was a grant's, so
-- they all become their grant's testing plan, and grants start with keyResultId null until a human writes goal KRs.
ALTER TABLE grants ADD COLUMN keyResultId TEXT;
ALTER TABLE grants ADD COLUMN approach TEXT NOT NULL DEFAULT '';
ALTER TABLE grants ADD COLUMN testingPlan TEXT NOT NULL DEFAULT '[]';
UPDATE grants SET testingPlan = COALESCE((
  SELECT json_group_array(json_object('text', text, 'howToCheck', howToCheck))
  FROM (SELECT text, howToCheck FROM key_results k WHERE k.grantId = grants.id ORDER BY position)
), '[]');
-- assignments that named an old key result: exploration keeps it as its gap sentence; grant work's KR is now implied
UPDATE assignments SET gap = COALESCE(gap, substr((SELECT text FROM key_results k WHERE k.id = assignments.keyResultId), 1, 300))
  WHERE keyResultId IS NOT NULL AND lane = 'exploration';
UPDATE assignments SET keyResultId = NULL WHERE keyResultId IS NOT NULL;
DROP TABLE key_results;
CREATE TABLE key_results (
  id TEXT PRIMARY KEY, buildingId TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, howToCheck TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not-started', statusNote TEXT NOT NULL DEFAULT '', statusBy TEXT, updatedAt TEXT NOT NULL
);
CREATE INDEX key_results_building ON key_results(buildingId, position);
CREATE INDEX grants_key_result ON grants(keyResultId);
-- goal-directed: since when the building is blocked (no goal KRs, no funded grant); the manager is woken once per transition
ALTER TABLE buildings ADD COLUMN blockedAt TEXT;
