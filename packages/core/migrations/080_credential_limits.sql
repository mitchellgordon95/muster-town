-- Promised and available (docs/bank.md, 2026-11-01): what the provider actually serves is observed per Bank input and
-- model class, never predicted. One row per observed limit; a success on the input and model clears it (clearedAt).
-- Numbered 080: an open PR holds 079.
CREATE TABLE credential_limits (
  id TEXT PRIMARY KEY,
  inputId TEXT NOT NULL,
  -- a model class (fable, opus, sonnet, haiku, other) or '*' for every model on the input
  scope TEXT NOT NULL,
  -- model-limit | window | billing | auth
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- the reset the provider named, when it named one
  until TEXT,
  -- with no reset known: when one session may try again (backoff doubles on each failure)
  probeAt TEXT,
  failures INTEGER NOT NULL DEFAULT 1,
  sessionId TEXT,
  since TEXT NOT NULL,
  lastAt TEXT NOT NULL,
  clearedAt TEXT
);
CREATE INDEX credential_limits_open ON credential_limits(inputId, clearedAt);
