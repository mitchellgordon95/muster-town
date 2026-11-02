-- The checkpoint card shows evidence (Mitchell 1:1 mt_7b4zc7yja3): checkpoint_grant takes the manager's line on what a
-- top-up would buy, with its number of tokens. Cleared when a new checkpoint holds the grant; empty = not stated.
ALTER TABLE grants ADD COLUMN topUpTokens INTEGER;
ALTER TABLE grants ADD COLUMN whatTopUpBuys TEXT NOT NULL DEFAULT '';
