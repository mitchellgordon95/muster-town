-- Build step 1 of docs/how-work-gets-done.md (as_1nuoiauxlw, 1:1 mt_wql34b8gkl): Bank pools and the per-goal daily
-- exploration allowance are deleted from the code. Additive: bank_pools, bank_debits.poolId, goals.poolId,
-- goals.explorationTokensPerDay, buildings.poolId and buildings.explorationTokensPerDay stay, read by nothing.

-- an optional cap on exploration per UTC day under a goal (inherited down the tree; the root's is town-wide; null = uncapped)
ALTER TABLE goals ADD COLUMN exploreCapTokensPerDay INTEGER;

-- a claim on free tokens for one exploration session; empty until the declarative explore step (§3) opens them
CREATE TABLE bank_reservations (
  id TEXT PRIMARY KEY,
  goalId TEXT NOT NULL,
  buildingId TEXT NOT NULL,
  assignmentId TEXT,
  tokens INTEGER NOT NULL,
  openedAt TEXT NOT NULL,
  closedAt TEXT,
  spentTokens INTEGER
);
CREATE INDEX bank_reservations_open ON bank_reservations(closedAt, goalId);
