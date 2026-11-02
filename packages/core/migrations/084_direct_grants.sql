-- "Direct work under <goal>" (grant gr_cuobjlny6r, Mitchell mt_hlizi9wxxc decision 1): a let-in member may open 1:1s and
-- meetings with, and be the human source of directed work for, buildings attached to this goal or one under it.
-- Additive: a new table, one row per (member, goal); no back-fill (existing members get it by an admin's or captain's click).
CREATE TABLE IF NOT EXISTS direct_grants (
  userId TEXT NOT NULL,
  goalId TEXT NOT NULL,
  grantedBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (userId, goalId)
);
CREATE INDEX IF NOT EXISTS direct_grants_goal ON direct_grants (goalId);
