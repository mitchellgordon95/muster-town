-- Browser errors (grant gr_cyqzweu6ed step 1): a crash or uncaught error in a browser on the live town, one row per kind.
-- A kind is its signature (core client-errors.ts errorSignature: the normalized message + the top stack frame). Counts and
-- commits only: no user id, IP, URL query or typed text. `panel` and `route` are the panel kind and the hash with ids blanked.
CREATE TABLE client_errors (
  signature TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  frame TEXT NOT NULL DEFAULT '',
  panel TEXT,
  route TEXT,
  firstCommit TEXT,
  lastCommit TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  firstSeen TEXT NOT NULL,
  lastSeen TEXT NOT NULL
);
CREATE INDEX client_errors_last_seen ON client_errors (lastSeen);
