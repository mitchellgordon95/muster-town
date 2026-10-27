-- Manager forks step 1 (design note dc_mymt27yz25): a fork is a short-lived agent row (forkOf = the manager, forkN = its
-- number); work can be queued to the building (queue 'building', run by a fork) and carry a model override; every
-- assignment carries the id of the first assignment of its chain. The manager's row counts the family's daily spend.
-- A building runs forks only with `forks` on (default off: nothing changes).
ALTER TABLE agents ADD COLUMN forkOf TEXT;
ALTER TABLE agents ADD COLUMN forkN INTEGER;
ALTER TABLE agents ADD COLUMN familySpentToday INTEGER NOT NULL DEFAULT 0;
UPDATE agents SET familySpentToday = COALESCE(spentTokensToday, 0);
CREATE INDEX agents_fork ON agents(forkOf);
ALTER TABLE assignments ADD COLUMN chainId TEXT;
ALTER TABLE assignments ADD COLUMN queue TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE assignments ADD COLUMN model TEXT;
CREATE INDEX assignments_chain ON assignments(chainId);
ALTER TABLE buildings ADD COLUMN forks INTEGER NOT NULL DEFAULT 0;
