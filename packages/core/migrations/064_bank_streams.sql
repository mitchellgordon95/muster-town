-- Goal tree build step 7 (docs/goals.md "Streams"; 1:1 mt_cz11aqe81a): a Bank input becomes a stream. `goalId` scopes it
-- to a goal node (an earmark): it pays only for sessions whose work sits in that node's subtree, and the general Bank
-- (the pools) never draws on it. NULL = the general balance, as before. `idleNotifiedAt`: when its donor was last told
-- that no session has drawn on it for 7 days (in-town notice only, 1:1 mt_kh0zaqui0w). Additive: old rows stay general.
ALTER TABLE bank_inputs ADD COLUMN goalId TEXT;
ALTER TABLE bank_inputs ADD COLUMN idleNotifiedAt TEXT;
CREATE INDEX IF NOT EXISTS bank_debits_input ON bank_debits(inputId, createdAt);
