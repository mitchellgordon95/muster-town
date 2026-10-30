-- One town-level goal tree (docs/goals.md, build step 1; Mitchell 1:1s mt_a3nvwfawer, mt_kh0zaqui0w). Additive: objectives
-- keep their ids as goals, every key result keeps its id, status and grants; grants are untouched; the old columns
-- (key_results.buildingId / objectiveId, the objectives table) stay in place.
CREATE TABLE goals (
  id TEXT PRIMARY KEY, parentId TEXT, position INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, ownerId TEXT,
  status TEXT NOT NULL DEFAULT 'active', retiredAt TEXT, retiredBy TEXT, retiredNote TEXT NOT NULL DEFAULT '',
  createdBy TEXT, editedBy TEXT, sourceDocIds TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX goals_parent ON goals(parentId, position);
-- managers' (and their forks') proposed tree changes; a human accepts or cuts each
CREATE TABLE goal_proposals (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, targetId TEXT, parentId TEXT, fields TEXT NOT NULL DEFAULT '{}', why TEXT NOT NULL DEFAULT '',
  proposedBy TEXT NOT NULL, buildingId TEXT, reorgId TEXT, sourceDocIds TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
  decidedBy TEXT, decidedAt TEXT, note TEXT NOT NULL DEFAULT '', resultId TEXT, createdAt TEXT NOT NULL
);
CREATE INDEX goal_proposals_status ON goal_proposals(status, createdAt);
-- "Change this goal" (the reorg, build step 5): created now so the tables land in one migration
CREATE TABLE goal_changes (
  id TEXT PRIMARY KEY, goalId TEXT NOT NULL, fromText TEXT NOT NULL, toText TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
  meetingDeadline TEXT NOT NULL, meetingId TEXT, sourceDocId TEXT, status TEXT NOT NULL DEFAULT 'prep',
  createdBy TEXT, createdAt TEXT NOT NULL, decidedAt TEXT
);
-- the one goal a building is attached to (nullable only so this migration is additive; the service never unsets it)
ALTER TABLE buildings ADD COLUMN goalId TEXT;
ALTER TABLE key_results ADD COLUMN goalId TEXT;
ALTER TABLE key_results ADD COLUMN due TEXT;
ALTER TABLE key_results ADD COLUMN archivedAt TEXT;
ALTER TABLE key_results ADD COLUMN underReviewSince TEXT;
ALTER TABLE key_results ADD COLUMN postmortemDocId TEXT;
CREATE INDEX key_results_goal ON key_results(goalId);
-- the admin role holds every permission: add the new one to its stored list
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'goals.edit')
  WHERE id = 'role:admin' AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'goals.edit');

-- the root (the town goal; owned by the town admins: ownerId stays null) and its placeholder children (no dials)
INSERT INTO goals (id, parentId, position, text, createdAt, updatedAt) VALUES
  ('gl_town', NULL, 0, COALESCE(NULLIF(json_extract((SELECT value FROM meta WHERE key = 'town'), '$.goal'), ''), 'The town goal'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('gl_fund', 'gl_town', 0, 'Fund', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('gl_join', 'gl_town', 1, 'Join', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('gl_trust', 'gl_town', 2, 'Trust', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- every lab gets its own goal gl_<buildingId> under the root (its goal line) and is attached to it; the Town Hall sits at the root
INSERT INTO goals (id, parentId, position, text, createdBy, createdAt, updatedAt)
  SELECT 'gl_' || id, 'gl_town', 3 + rowid, substr(COALESCE(NULLIF(goal, ''), name), 1, 300), createdBy, createdAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM buildings WHERE kind != 'town-hall';
UPDATE buildings SET goalId = CASE WHEN kind = 'town-hall' THEN 'gl_town' ELSE 'gl_' || id END;
-- every objective becomes a goal with the same id under its building's goal
INSERT INTO goals (id, parentId, position, text, createdBy, editedBy, sourceDocIds, createdAt, updatedAt)
  SELECT o.id, 'gl_' || o.buildingId, o.position, o.text, o.createdBy, o.editedBy, o.sourceDocIds, o.updatedAt, o.updatedAt
  FROM objectives o JOIN buildings b ON b.id = o.buildingId;
-- key results: under their objective, else directly under their building's goal; met and missed ones archive
UPDATE key_results SET goalId = CASE
  WHEN objectiveId IS NOT NULL AND objectiveId IN (SELECT id FROM goals) THEN objectiveId
  WHEN ('gl_' || buildingId) IN (SELECT id FROM goals) THEN 'gl_' || buildingId
  ELSE 'gl_town' END;
UPDATE key_results SET archivedAt = updatedAt WHERE status IN ('met', 'missed');
