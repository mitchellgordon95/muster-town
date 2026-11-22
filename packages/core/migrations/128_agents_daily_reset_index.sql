-- gr_ouc0w8us88 step 1: Budget.resetDaily reads only the agents it changes (spend today, or out-of-budget).
-- A partial index holds just those rows, so the midnight reset never scans the tens of thousands of retired forks.
-- The WHERE must stay the same text as the one in budget.ts resetDaily, or SQLite will not use the index.
CREATE INDEX IF NOT EXISTS agents_daily_reset ON agents(id) WHERE spentTokensToday != 0 OR familySpentToday != 0 OR status = 'out-of-budget';
