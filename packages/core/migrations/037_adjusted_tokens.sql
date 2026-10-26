-- Bank grant step 3 (gr_iq5m7dug56): the Bank books, compares and shows adjusted output tokens (docs/bank.md).
-- Ledger rows (usage, bank_debits, bank_credits) and an allocation's spend: `tokens` / `spentTokens` become STORED,
-- the booked adjusted figure (output + Σ weight × count, at list price); the raw sum moves to the generated
-- `rawTokens` / `spentRawTokens`, so the five counters and the raw total stay visible alongside.
-- Every size (inputs, caps, allocations, grants, allowances, agents' spend, donations) is converted once at the step-1
-- ratio, the back-fill rule of migration 034: 1 adjusted = 30 raw (Opus and any non-Fable model) / 24 raw (Fable).
-- Weights (Opus 5.5 / Fable 5.1 list prices over output): input 0.2, cache read 0.01 (Fable 0.005), 5m 0.25, 1h 0.4.
-- Rows with no model count as Opus; a credit and an input take their input's model. The conversion is recorded in one
-- `bank.converted` event with every converted figure before and after, so it is auditable.

INSERT INTO events (ts, type, text, payload) SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'bank.converted',
  'The Bank now counts adjusted output tokens: every size converted at 30 raw (Opus) / 24 raw (Fable) per adjusted token',
  json_object(
    'ratio', json_object('opus', 30, 'fable', 24),
    'inputs', (SELECT json_group_array(json_object('id', id, 'model', model,
      'tokens', json_array(tokens, MAX(1, CAST(ROUND(tokens * 1.0 / (CASE WHEN model LIKE '%fable%' THEN 24 ELSE 30 END)) AS INTEGER))),
      'weeklyCapTokens', json_array(weeklyCapTokens, CASE WHEN weeklyCapTokens IS NULL THEN NULL ELSE MAX(1, CAST(ROUND(weeklyCapTokens * 1.0 / (CASE WHEN model LIKE '%fable%' THEN 24 ELSE 30 END)) AS INTEGER)) END),
      'creditedTokens', json_array(creditedTokens, CAST(ROUND(creditedTokens * 1.0 / (CASE WHEN model LIKE '%fable%' THEN 24 ELSE 30 END)) AS INTEGER)))) FROM bank_inputs),
    'grants', (SELECT json_group_array(json_object('id', id,
      'askTokens', json_array(askTokens, MAX(1, CAST(ROUND(askTokens / 30.0) AS INTEGER))),
      'grantTokens', json_array(grantTokens, CASE WHEN grantTokens IS NULL THEN NULL ELSE MAX(1, CAST(ROUND(grantTokens / 30.0) AS INTEGER)) END))) FROM grants),
    'buildings', (SELECT json_group_array(json_object('id', id,
      'dailyTokensPerAgent', json_array(dailyTokensPerAgent, CASE WHEN dailyTokensPerAgent IS NULL THEN NULL ELSE MAX(1, CAST(ROUND(dailyTokensPerAgent / 30.0) AS INTEGER)) END),
      'explorationTokensPerDay', json_array(explorationTokensPerDay, CASE WHEN explorationTokensPerDay IS NULL THEN NULL ELSE CAST(ROUND(explorationTokensPerDay / 30.0) AS INTEGER) END))) FROM buildings),
    'allocations', (SELECT json_group_array(json_object('id', id, 'tokens', json_array(tokens, MAX(1, CAST(ROUND(tokens / 30.0) AS INTEGER))))) FROM allocations)
  )
  -- a fresh database (migrations run before the seed) has nothing to convert
  WHERE EXISTS (SELECT 1 FROM bank_inputs) OR EXISTS (SELECT 1 FROM grants) OR EXISTS (SELECT 1 FROM allocations) OR EXISTS (SELECT 1 FROM usage);

-- sizes
UPDATE bank_inputs SET
  tokens = MAX(1, CAST(ROUND(tokens * 1.0 / (CASE WHEN model LIKE '%fable%' THEN 24 ELSE 30 END)) AS INTEGER)),
  weeklyCapTokens = CASE WHEN weeklyCapTokens IS NULL THEN NULL ELSE MAX(1, CAST(ROUND(weeklyCapTokens * 1.0 / (CASE WHEN model LIKE '%fable%' THEN 24 ELSE 30 END)) AS INTEGER)) END,
  creditedTokens = CAST(ROUND(creditedTokens * 1.0 / (CASE WHEN model LIKE '%fable%' THEN 24 ELSE 30 END)) AS INTEGER);
UPDATE allocations SET tokens = MAX(1, CAST(ROUND(tokens / 30.0) AS INTEGER));
UPDATE grants SET askTokens = MAX(1, CAST(ROUND(askTokens / 30.0) AS INTEGER)),
  grantTokens = CASE WHEN grantTokens IS NULL THEN NULL ELSE MAX(1, CAST(ROUND(grantTokens / 30.0) AS INTEGER)) END;
UPDATE grants SET history = (SELECT json_group_array(CASE WHEN json_extract(h.value, '$.tokens') IS NULL THEN json(h.value)
    ELSE json_set(h.value, '$.tokens', MAX(1, CAST(ROUND(json_extract(h.value, '$.tokens') / 30.0) AS INTEGER))) END)
  FROM json_each(grants.history) h)
  WHERE history IS NOT NULL AND json_valid(history);
UPDATE buildings SET dailyTokensPerAgent = CASE WHEN dailyTokensPerAgent IS NULL THEN NULL ELSE MAX(1, CAST(ROUND(dailyTokensPerAgent / 30.0) AS INTEGER)) END,
  explorationTokensPerDay = CASE WHEN explorationTokensPerDay IS NULL THEN NULL ELSE CAST(ROUND(explorationTokensPerDay / 30.0) AS INTEGER) END;
UPDATE agents SET spentTokensToday = CAST(ROUND(spentTokensToday / 30.0) AS INTEGER), spentTokensTotal = CAST(ROUND(spentTokensTotal / 30.0) AS INTEGER);
-- a report's stamped session tokens (shown in the in-tray and on the doc) are adjusted from now on (runtime work.ts)
UPDATE docs SET tokens = CAST(ROUND(tokens / 30.0) AS INTEGER) WHERE tokens IS NOT NULL;
UPDATE users SET donatedTokens = CAST(ROUND(donatedTokens / 30.0) AS INTEGER);

-- usage ledger (Opus): booked adjusted stored, raw generated
ALTER TABLE usage DROP COLUMN tokens;
ALTER TABLE usage ADD COLUMN rawTokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;
ALTER TABLE usage ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
UPDATE usage SET tokens = CAST(ROUND(output + 0.2 * input + 0.01 * cacheRead + 0.25 * cacheWrite5m + 0.4 * cacheWrite1h) AS INTEGER);

-- Bank debits (Opus)
ALTER TABLE bank_debits DROP COLUMN tokens;
ALTER TABLE bank_debits ADD COLUMN rawTokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;
ALTER TABLE bank_debits ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
UPDATE bank_debits SET tokens = CAST(ROUND(output + 0.2 * input + 0.01 * cacheRead + 0.25 * cacheWrite5m + 0.4 * cacheWrite1h) AS INTEGER);

-- Bank credits (their input's model)
ALTER TABLE bank_credits DROP COLUMN tokens;
ALTER TABLE bank_credits ADD COLUMN rawTokens INTEGER GENERATED ALWAYS AS (input + output + cacheRead + cacheWrite5m + cacheWrite1h) VIRTUAL;
ALTER TABLE bank_credits ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
UPDATE bank_credits SET tokens = CAST(ROUND(output + 0.2 * input + 0.25 * cacheWrite5m + 0.4 * cacheWrite1h
  + cacheRead * (CASE WHEN (SELECT model FROM bank_inputs WHERE bank_inputs.id = bank_credits.inputId) LIKE '%fable%' THEN 0.005 ELSE 0.01 END)) AS INTEGER);

-- allocations: what each has paid for (Opus)
ALTER TABLE allocations DROP COLUMN spentTokens;
ALTER TABLE allocations ADD COLUMN spentRawTokens INTEGER GENERATED ALWAYS AS (spentInput + spentOutput + spentCacheRead + spentCacheWrite5m + spentCacheWrite1h) VIRTUAL;
ALTER TABLE allocations ADD COLUMN spentTokens INTEGER NOT NULL DEFAULT 0;
UPDATE allocations SET spentTokens = CAST(ROUND(spentOutput + 0.2 * spentInput + 0.01 * spentCacheRead + 0.25 * spentCacheWrite5m + 0.4 * spentCacheWrite1h) AS INTEGER);
