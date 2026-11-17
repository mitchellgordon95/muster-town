-- The town's three standing pages become town pins (design dc_8194l8soj4 §3-4, grant gr_y4s2j99vgm step 2): the
-- operating manual (the first published Town Hall doc tagged operating-manual) and the policy ledger (the first Town
-- Hall doc of type policy) always on, the town dictionary (the first of type dictionary) listed. Seeded (seeded = 1),
-- placed by code under Mitchell's mapping (1:1 mt_uarrn0kco1 decision 1). Back-fill only: it runs once, so a pin a
-- human removes later stays removed. New docs get theirs on creation (Skills.seed).
INSERT OR IGNORE INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, seeded, createdAt)
SELECT 'sp_seed_' || id, id, 'town', NULL, 'always', 'system', 'user', 1, 1, createdAt FROM docs
WHERE id = (SELECT id FROM docs WHERE buildingId = 'town-hall' AND state IN ('building', 'library') AND tags LIKE '%"operating-manual"%' ORDER BY createdAt, rowid LIMIT 1);
INSERT OR IGNORE INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, seeded, createdAt)
SELECT 'sp_seed_' || id, id, 'town', NULL, 'always', 'system', 'user', 1, 1, createdAt FROM docs
WHERE id = (SELECT id FROM docs WHERE type = 'policy' AND buildingId = 'town-hall' ORDER BY createdAt, rowid LIMIT 1);
INSERT OR IGNORE INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, seeded, createdAt)
SELECT 'sp_seed_' || id, id, 'town', NULL, 'listed', 'system', 'user', 1, 1, createdAt FROM docs
WHERE id = (SELECT id FROM docs WHERE type = 'dictionary' AND buildingId = 'town-hall' ORDER BY createdAt, rowid LIMIT 1);
