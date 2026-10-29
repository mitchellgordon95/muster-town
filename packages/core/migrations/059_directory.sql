-- Self-hosted towns directory (grant gr_8cdix9mpye, kr_og03nxrkct, design dc_d6chojzl2a): one row per registered host.
-- Only muster.town (MUSTER_TOWN_DIRECTORY=on) writes it; every other World gets the empty tables.
CREATE TABLE directory_towns (
  host          TEXT PRIMARY KEY,          -- normalized ASCII hostname
  token         TEXT NOT NULL,             -- mtd_…, public by design
  createdAt     TEXT NOT NULL,
  createdIp     TEXT,                       -- for the per-IP pending cap; never shown
  proof         TEXT CHECK (proof IN ('txt','well-known')),  -- the form that last passed
  verifiedAt    TEXT,                       -- first pass of the current proof run; null = pending or delisted
  proofMisses   INTEGER NOT NULL DEFAULT 0, -- consecutive checks with the proof gone
  lastCheckAt   TEXT,
  nextCheckAt   TEXT NOT NULL,              -- the checker's queue
  lastSeenAt    TEXT,                       -- last time health + collectives answered
  name          TEXT NOT NULL DEFAULT '',
  goal          TEXT NOT NULL DEFAULT '',
  lastError     TEXT                        -- short, shown to the registrant on /verify
);
CREATE INDEX directory_towns_next ON directory_towns(nextCheckAt);
CREATE TABLE directory_blocked (host TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
