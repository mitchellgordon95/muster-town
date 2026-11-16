-- The Bank's ledger starts when correct accounting began (town meeting mt_dm14dgejml, agenda 3, decision 4; Mitchell:
-- "i'm open to just deleting the records from before we started doing correct accounting, maybe with a note on the
-- relevant data"). The cutoff is the `bank.converted` event (migration 037): before it the Bank counted raw tokens,
-- split into output + cache read by a fixed back-fill ratio (docs/bank.md "Back-fill rule"), with no real cache
-- reads, inputs or cache writes. Records from before it are deleted:
--   - usage rows, Bank debits and sessions (ended) dated before the cutoff;
--   - Bank credits dated before it that have expired and that no remaining debit draws on;
--   - Bank inputs created before it, cancelled, with no remaining credit or debit;
--   - retired direct donations (allocations) made before it.
-- What can still be spent (`left`) does not move: only expired subscription credits go (with their draws), and the
-- durable rows go only when the durable balance stays the same. What was removed is kept in
-- `meta` under `ledgerCutoff` (the Bank page's note reads it) and in one `bank.pruned` event. Nothing is written when
-- there is nothing before the cutoff (a world born after 037).

CREATE TEMP TABLE _cut AS SELECT MIN(ts) AS at FROM events WHERE type = 'bank.converted';

-- Durable credits (expiresAt NULL) are drawn as one pool by debits with no creditId: their rows before the cutoff go only
-- when that leaves the durable balance, max(0, credits - debits), unchanged.
CREATE TEMP TABLE _durable AS SELECT
  (SELECT COALESCE(SUM(tokens), 0) FROM bank_credits WHERE expiresAt IS NULL) AS credits,
  (SELECT COALESCE(SUM(tokens), 0) FROM bank_debits WHERE creditId IS NULL) AS debits,
  (SELECT COALESCE(SUM(tokens), 0) FROM bank_credits WHERE expiresAt IS NULL AND createdAt < (SELECT at FROM _cut)) AS goneCredits,
  (SELECT COALESCE(SUM(tokens), 0) FROM bank_debits WHERE creditId IS NULL AND createdAt < (SELECT at FROM _cut)) AS goneDebits;
CREATE TEMP TABLE _durable_ok AS SELECT
  MAX(0, credits - debits) = MAX(0, (credits - goneCredits) - (debits - goneDebits)) AS ok FROM _durable;

-- a debit before the cutoff goes unless it draws on a subscription credit that has not expired yet (its draw is still
-- part of that credit's balance) or on the durable pool when that pool must stay
CREATE TEMP TABLE _gone_debits AS
  SELECT d.id, d.tokens FROM bank_debits d
  WHERE d.createdAt < (SELECT at FROM _cut)
    AND CASE WHEN d.creditId IS NULL THEN (SELECT ok FROM _durable_ok)
      ELSE NOT EXISTS (SELECT 1 FROM bank_credits c WHERE c.id = d.creditId AND c.expiresAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) END;
-- a credit before the cutoff goes when it has expired and no remaining debit draws on it (a durable one: with its pool)
CREATE TEMP TABLE _gone_credits AS
  SELECT c.id, c.tokens FROM bank_credits c
  WHERE c.createdAt < (SELECT at FROM _cut)
    AND CASE WHEN c.expiresAt IS NULL THEN (SELECT ok FROM _durable_ok)
      ELSE c.expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND NOT EXISTS (SELECT 1 FROM bank_debits d WHERE d.creditId = c.id AND d.id NOT IN (SELECT id FROM _gone_debits)) END;
CREATE TEMP TABLE _gone_inputs AS
  SELECT i.id FROM bank_inputs i
  WHERE i.createdAt < (SELECT at FROM _cut) AND i.cancelledAt IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM bank_credits c WHERE c.inputId = i.id AND c.id NOT IN (SELECT id FROM _gone_credits))
    AND NOT EXISTS (SELECT 1 FROM bank_debits d WHERE d.inputId = i.id AND d.id NOT IN (SELECT id FROM _gone_debits));
CREATE TEMP TABLE _gone_usage AS
  SELECT id, tokens FROM usage WHERE createdAt < (SELECT at FROM _cut);
CREATE TEMP TABLE _gone_allocations AS
  SELECT id, spentTokens, MIN(tokens, spentTokens) AS donated FROM allocations
  WHERE createdAt < (SELECT at FROM _cut) AND retired = 1;
CREATE TEMP TABLE _gone_sessions AS
  SELECT id FROM sessions WHERE endedAt IS NOT NULL AND endedAt < (SELECT at FROM _cut);

CREATE TEMP TABLE _cutoff AS SELECT json_object(
  'at', (SELECT at FROM _cut),
  'prunedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'reason', 'Before this time the Bank counted raw tokens, split by a fixed estimate: it had no real cache reads, input or cache writes.',
  'removed', json_object(
    'sessions', (SELECT COUNT(*) FROM _gone_sessions),
    'usage', (SELECT COUNT(*) FROM _gone_usage),
    'debits', (SELECT COUNT(*) FROM _gone_debits),
    'credits', (SELECT COUNT(*) FROM _gone_credits),
    'inputs', (SELECT COUNT(*) FROM _gone_inputs),
    'allocations', (SELECT COUNT(*) FROM _gone_allocations)
  ),
  'tokens', json_object(
    'usage', (SELECT COALESCE(SUM(tokens), 0) FROM _gone_usage),
    'debits', (SELECT COALESCE(SUM(tokens), 0) FROM _gone_debits),
    'credits', (SELECT COALESCE(SUM(tokens), 0) FROM _gone_credits),
    'donated', (SELECT COALESCE(SUM(donated), 0) FROM _gone_allocations),
    'donationsSpent', (SELECT COALESCE(SUM(spentTokens), 0) FROM _gone_allocations)
  )
) AS value
WHERE (SELECT at FROM _cut) IS NOT NULL
  AND (SELECT COUNT(*) FROM _gone_sessions) + (SELECT COUNT(*) FROM _gone_usage) + (SELECT COUNT(*) FROM _gone_debits)
    + (SELECT COUNT(*) FROM _gone_credits) + (SELECT COUNT(*) FROM _gone_inputs) + (SELECT COUNT(*) FROM _gone_allocations) > 0;

INSERT OR REPLACE INTO meta (key, value) SELECT 'ledgerCutoff', value FROM _cutoff;
INSERT INTO events (ts, type, text, payload) SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'bank.pruned',
  'The Bank deleted its ledger records from before ' || json_extract(value, '$.at') || ', when it began counting adjusted tokens from real counters: '
    || json_extract(value, '$.removed.sessions') || ' sessions, ' || json_extract(value, '$.removed.usage') || ' usage rows, '
    || json_extract(value, '$.removed.debits') || ' debits, ' || json_extract(value, '$.removed.credits') || ' credits, '
    || json_extract(value, '$.removed.inputs') || ' inputs, ' || json_extract(value, '$.removed.allocations') || ' donations',
  value
FROM _cutoff;

DELETE FROM bank_debits WHERE id IN (SELECT id FROM _gone_debits);
DELETE FROM bank_credits WHERE id IN (SELECT id FROM _gone_credits);
DELETE FROM bank_inputs WHERE id IN (SELECT id FROM _gone_inputs);
DELETE FROM usage WHERE id IN (SELECT id FROM _gone_usage);
DELETE FROM allocations WHERE id IN (SELECT id FROM _gone_allocations);
DELETE FROM sessions WHERE id IN (SELECT id FROM _gone_sessions);

DROP TABLE _cut; DROP TABLE _durable; DROP TABLE _durable_ok; DROP TABLE _gone_debits; DROP TABLE _gone_credits; DROP TABLE _gone_inputs;
DROP TABLE _gone_usage; DROP TABLE _gone_allocations; DROP TABLE _gone_sessions; DROP TABLE _cutoff;
