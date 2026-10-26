-- Bank grant step 1 (gr_iq5m7dug56): every row the Bank books keeps five token counters (input, output, cache read,
-- cache write 5m, cache write 1h). The raw total becomes a generated column, their sum: never a second source of truth.
-- Back-fill (docs/bank.md): a row with only a raw total is split output + cache read so that step 2's adjusted value
-- (output + cacheRead × cache-read / output price) is exactly raw / ratio, from dc_2uqmfdittg:
--   Opus (and any non-Fable model): ratio 30, weight 0.01  → output = raw × (1/30 − 0.01) / (1 − 0.01)  (2.357%)
--   Fable:                           ratio 24, weight 0.005 → output = raw × (1/24 − 0.005) / (1 − 0.005) (3.706%)
-- cacheRead = raw − output; input and cache writes 0. Same rule as splitRaw in packages/schema/src/tokens.ts.
-- Rows with no model (debits, usage, allocation spend) count as Opus; a credit takes its input's model.

-- sessions (model per row)
ALTER TABLE sessions ADD COLUMN input INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN output INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cacheRead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cacheWrite5m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cacheWrite1h INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET output = CASE WHEN model LIKE '%fable%'
  THEN CAST(ROUND(COALESCE(tokens, 0) * (1.0 / 24 - 0.005) / (1 - 0.005)) AS INTEGER)
  ELSE CAST(ROUND(COALESCE(tokens, 0) * (1.0 / 30 - 0.01) / (1 - 0.01)) AS INTEGER) END;
UPDATE sessions SET cacheRead = COALESCE(tokens, 0) - output;
ALTER TABLE sessions DROP COLUMN tokens;
ALTER TABLE sessions ADD COLUMN tokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;

-- usage ledger (Opus)
ALTER TABLE usage ADD COLUMN input INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN output INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN cacheRead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN cacheWrite5m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN cacheWrite1h INTEGER NOT NULL DEFAULT 0;
UPDATE usage SET output = CAST(ROUND(tokens * (1.0 / 30 - 0.01) / (1 - 0.01)) AS INTEGER);
UPDATE usage SET cacheRead = tokens - output;
ALTER TABLE usage DROP COLUMN tokens;
ALTER TABLE usage ADD COLUMN tokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;

-- Bank debits (Opus)
ALTER TABLE bank_debits ADD COLUMN input INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_debits ADD COLUMN output INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_debits ADD COLUMN cacheRead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_debits ADD COLUMN cacheWrite5m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_debits ADD COLUMN cacheWrite1h INTEGER NOT NULL DEFAULT 0;
UPDATE bank_debits SET output = CAST(ROUND(tokens * (1.0 / 30 - 0.01) / (1 - 0.01)) AS INTEGER);
UPDATE bank_debits SET cacheRead = tokens - output;
ALTER TABLE bank_debits DROP COLUMN tokens;
ALTER TABLE bank_debits ADD COLUMN tokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;

-- Bank credits (their input's model)
ALTER TABLE bank_credits ADD COLUMN input INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_credits ADD COLUMN output INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_credits ADD COLUMN cacheRead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_credits ADD COLUMN cacheWrite5m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_credits ADD COLUMN cacheWrite1h INTEGER NOT NULL DEFAULT 0;
UPDATE bank_credits SET output = CASE WHEN (SELECT model FROM bank_inputs WHERE bank_inputs.id = bank_credits.inputId) LIKE '%fable%'
  THEN CAST(ROUND(tokens * (1.0 / 24 - 0.005) / (1 - 0.005)) AS INTEGER)
  ELSE CAST(ROUND(tokens * (1.0 / 30 - 0.01) / (1 - 0.01)) AS INTEGER) END;
UPDATE bank_credits SET cacheRead = tokens - output;
ALTER TABLE bank_credits DROP COLUMN tokens;
ALTER TABLE bank_credits ADD COLUMN tokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;

-- allocations: what each has paid for (Opus); its size `tokens` stays a raw number until step 3
ALTER TABLE allocations ADD COLUMN spentInput INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allocations ADD COLUMN spentOutput INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allocations ADD COLUMN spentCacheRead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allocations ADD COLUMN spentCacheWrite5m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allocations ADD COLUMN spentCacheWrite1h INTEGER NOT NULL DEFAULT 0;
UPDATE allocations SET spentOutput = CAST(ROUND(spentTokens * (1.0 / 30 - 0.01) / (1 - 0.01)) AS INTEGER);
UPDATE allocations SET spentCacheRead = spentTokens - spentOutput;
ALTER TABLE allocations DROP COLUMN spentTokens;
ALTER TABLE allocations ADD COLUMN spentTokens INTEGER GENERATED ALWAYS AS (spentInput + spentOutput + spentCacheRead + spentCacheWrite5m + spentCacheWrite1h) VIRTUAL;
