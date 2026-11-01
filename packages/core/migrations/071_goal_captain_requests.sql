-- "Ask to captain this goal" (grant gr_bwm0iz7rwl, kr_j1w17nw178): a member asks to captain a goal node (goals.ownerId);
-- the request waits in the Town Hall in-tray, routed to the node's current captain (the root always has one since migration 078).
-- A sibling of access_requests rather than a goalId column on it: its own status words (accepted, not granted), many
-- requests per user (one pending per goal), and a different decider. Additive: a new table.
CREATE TABLE goal_captain_requests (
  id TEXT PRIMARY KEY, goalId TEXT NOT NULL, userId TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', decidedBy TEXT, decisionNote TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL, decidedAt TEXT
);
CREATE INDEX goal_captain_requests_status ON goal_captain_requests(status, createdAt);
CREATE INDEX goal_captain_requests_goal_user ON goal_captain_requests(goalId, userId, status);
