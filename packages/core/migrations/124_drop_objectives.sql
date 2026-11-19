-- Objectives are goals (grant gr_h4m0lyhb1f step 1; docs/goals.md): migration 061 made every objective a goal with the
-- same id under its building's goal, and objectives written after it got their goal row on create. Before the table goes,
-- any objective with no goal row is written as one under its building's attachment, so no ob_ row is lost; then the
-- table drops. key_results.objectiveId stays as a dead column until step 2 removes it.
INSERT INTO goals (id, parentId, position, text, createdBy, editedBy, sourceDocIds, createdAt, updatedAt)
  SELECT o.id, COALESCE(b.goalId, 'gl_' || o.buildingId), o.position, o.text, o.createdBy, o.editedBy, o.sourceDocIds, o.updatedAt, o.updatedAt
  FROM objectives o JOIN buildings b ON b.id = o.buildingId
  WHERE o.id NOT IN (SELECT id FROM goals);
DROP TABLE objectives;
