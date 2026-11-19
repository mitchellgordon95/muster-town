-- Grants route by goalId (grant gr_h4m0lyhb1f step 3; docs/goals.md "Routing"): a grant sits in the one goal tree by
-- its goalId alone. Its first key result was also stored on it (keyResultId, migration 032) and copied onto its
-- assignments and schedules; every read now goes grant → goalId, and a grant's key results are read by their grantId.
-- A grant with no goalId takes its first key result's goal before the column goes, so no grant loses its place.
UPDATE grants SET goalId = (SELECT k.goalId FROM key_results k WHERE k.id = grants.keyResultId)
  WHERE goalId IS NULL AND keyResultId IS NOT NULL;
DROP INDEX IF EXISTS grants_key_result;
ALTER TABLE grants DROP COLUMN keyResultId;
ALTER TABLE assignments DROP COLUMN keyResultId;
ALTER TABLE schedules DROP COLUMN keyResultId;
