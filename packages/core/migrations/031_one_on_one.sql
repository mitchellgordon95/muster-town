-- The manager's 1:1 (docs/waterfall.md §3.4): a meeting of kind `one-on-one` between a human and the building's manager agent.
ALTER TABLE meetings ADD COLUMN withUserId TEXT;
