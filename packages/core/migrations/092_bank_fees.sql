-- gr_qggxximtru step 1 (091): what the town pays in cash for a subscription plan (docs/bank.md "Plans paid for").
-- A fee is its own record, not a column on bank_inputs: one plan is split across many inputs over time (a token is
-- replaced, an input cancelled and re-added). Dates are UTC days 'YYYY-MM-DD'; toDate NULL = ongoing. Additive.
CREATE TABLE IF NOT EXISTS bank_fees (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  paidBy TEXT NOT NULL,
  usdPerMonth REAL NOT NULL,
  fromDate TEXT NOT NULL,
  toDate TEXT,
  createdAt TEXT NOT NULL
);
