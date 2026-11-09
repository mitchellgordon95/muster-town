-- Legible Delegation step 1 (docs/legible-delegation.md §4, §11): an ask is a stored object, not a regex match over a
-- report. Created in code where its source is created (a grant proposed or held, a retainer asked, an outbox request, a
-- captain or access request, a rollup's typed `asks`), deduped by (targetKind, targetId), retired by the target's
-- deciding event, decided only by a human. JSON columns (branches, claims, sources, history) are TEXT like the rest.
-- Additive: a new table. What is open at boot is backfilled in code (core asks.ts `backfillAsks`, idempotent).
CREATE TABLE asks (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, targetKind TEXT, targetId TEXT, buildingId TEXT, sourceDocId TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', branches TEXT NOT NULL DEFAULT '[]', recommendation TEXT NOT NULL DEFAULT '',
  claims TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
  decidedBy TEXT, decidedAt TEXT, decision TEXT, retiredBy TEXT, foldedInto TEXT, deferredUntil TEXT,
  sources TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX asks_status ON asks(status, createdAt);
CREATE INDEX asks_target ON asks(targetKind, targetId);
