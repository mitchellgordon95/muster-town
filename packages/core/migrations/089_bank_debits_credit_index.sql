-- gr_db6ofyd0yf step 2 (089): Bank.debited sums debits by creditId on every available()/totals()/unavailable() call (via
-- Budget.remaining, several times per runtime tick). No index led with creditId, so each sum, and the durable one
-- (creditId IS NULL OR creditId IN (...)), scanned the whole table: 55 % of the 2x desk tick. Covering index: the sums
-- read (creditId, tokens) from the index alone. Additive; no row changes.
CREATE INDEX IF NOT EXISTS bank_debits_credit ON bank_debits(creditId, tokens);
