-- Grant B (gr_b5fyqibfx2): a proposal carries its steps; funding queues step 1 on the building queue (the manager's
-- "Grant … funded: assign its first step" kickoff session is gone, no fallback: 1:1 mt_stsjh68yz2 decision 1).
-- An assignment remembers which step of its grant it runs (0-based), so its report queues the next one.
ALTER TABLE grants ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assignments ADD COLUMN grantStep INTEGER;
-- Every open proposal (draft, proposed, countered) gets one step from its own plan; funded, held, closed, rejected
-- grants are untouched (their manager already cut them into assignments).
UPDATE grants SET steps = json_array(json_object(
  'title', substr('Step 1: ' || objective, 1, 160),
  'description', CASE WHEN trim(approach) = '' THEN 'Carry out the plan: ' || objective ELSE 'As in the approach: ' || approach END
)) WHERE status IN ('draft', 'proposed', 'countered');
