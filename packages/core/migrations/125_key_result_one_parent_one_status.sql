-- A key result has one parent and one status (grant gr_h4m0lyhb1f step 2; docs/goals.md "Key results"). Its parent is
-- its grant (grantId); its building is the grant's, so buildingId goes, and objectiveId (dead since 124) goes with it.
-- goalId stays as a copy of the grant's goalId, written only with the grant. Status collapses to open / claimed / met /
-- met-unverified / missed, and the evidence column (migration 103) folds into it:
--   not-started, on-track, at-risk → open (how far along open work is goes in the report's words);
--   met with evidence verified (a human marked it, or a server check passed) → met;
--   met with evidence unknown (a close as done that nobody claimed or checked) → met-unverified, for those written
--   before "met, unverified" existed (1:1 mt_msnjkpgwdb decision 9, c440b5d2, 2026-11-12 19:32Z); since then the close
--   itself picks met (a live check named) or met-unverified, so a later met already says which and stays met;
--   met with evidence claimed (a fork's or manager's claim, then a close) stays met, by the same rule;
--   claimed stays claimed, met-unverified and missed stay as they are.
UPDATE key_results SET status = 'open' WHERE status IN ('not-started', 'on-track', 'at-risk');
UPDATE key_results SET status = 'met-unverified'
  WHERE status = 'met' AND COALESCE(evidence, 'unknown') = 'unknown' AND updatedAt < '2026-11-12T19:32:07Z';
UPDATE key_results SET status = 'open' WHERE status NOT IN ('open', 'claimed', 'met', 'met-unverified', 'missed');
DROP INDEX IF EXISTS key_results_building;
ALTER TABLE key_results DROP COLUMN buildingId;
ALTER TABLE key_results DROP COLUMN objectiveId;
ALTER TABLE key_results DROP COLUMN evidence;
