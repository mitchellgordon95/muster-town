-- town Bank: inputs (API keys, the owner's subscription) and the credits they pay in. apiKey is secret.
CREATE TABLE bank_inputs (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
  tokens INTEGER NOT NULL, recurrence TEXT NOT NULL, weeklyCapTokens INTEGER, nextCreditAt TEXT,
  creditedTokens INTEGER NOT NULL DEFAULT 0, hasApiKey INTEGER NOT NULL DEFAULT 0, cancelledAt TEXT,
  createdAt TEXT NOT NULL, apiKey TEXT
);
CREATE TABLE bank_credits (id TEXT PRIMARY KEY, inputId TEXT NOT NULL, tokens INTEGER NOT NULL, createdAt TEXT NOT NULL);
CREATE INDEX bank_credits_input ON bank_credits(inputId, createdAt);
