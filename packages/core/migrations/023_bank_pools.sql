-- Accounting pools replace per-building Bank shares: buildings join a pool, pools get the % of the Bank.
-- Every building starts in General; a building that had an explicit share gets its own pool with that %,
-- so what each building can draw doesn't change.
CREATE TABLE bank_pools (id TEXT PRIMARY KEY, name TEXT NOT NULL, pct REAL, createdAt TEXT NOT NULL);
INSERT INTO bank_pools (id, name, pct, createdAt) VALUES ('general', 'General', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
ALTER TABLE buildings ADD COLUMN poolId TEXT;
UPDATE buildings SET poolId = 'general';
INSERT INTO bank_pools (id, name, pct, createdAt)
  SELECT 'pool-' || s.buildingId, b.name, s.pct, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM bank_shares s JOIN buildings b ON b.id = s.buildingId;
UPDATE buildings SET poolId = 'pool-' || id WHERE id IN (SELECT buildingId FROM bank_shares);
DROP TABLE bank_shares;
ALTER TABLE bank_debits ADD COLUMN poolId TEXT NOT NULL DEFAULT 'general';
UPDATE bank_debits SET poolId = COALESCE((SELECT poolId FROM buildings WHERE buildings.id = bank_debits.buildingId), 'general');
CREATE INDEX bank_debits_pool ON bank_debits(poolId, creditId);
