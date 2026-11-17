-- Pins step 3 (design dc_8194l8soj4 §3-4, grant gr_y4s2j99vgm): the pages that entered sessions by their own blocks
-- become seeded pins (seeded = 1, placed by code under Mitchell's mapping, 1:1 mt_uarrn0kco1 decision 1):
--   a building's published topic pages → building / listed (they were the "## Topic pages" index and the fork's
--   title-match guess); a building manager's private wiki pages → agent (the manager) / listed (they were the
--   manager's wiki index and the fork's "What <manager> knows" copy); Town Hall docs tagged town-page → town / listed.
-- Back-fill only: it runs once, so a pin a human removes later stays removed. New pages get theirs on creation
-- (Skills.seed).
INSERT OR IGNORE INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, seeded, createdAt)
SELECT 'sp_seed_' || id, id, 'building', topicOf, 'listed', 'system', 'user', 1, 1, createdAt FROM docs
WHERE type = 'wiki' AND topicOf IS NOT NULL AND state != 'draft';
INSERT OR IGNORE INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, seeded, createdAt)
SELECT 'sp_seed_' || id, id, 'agent', authorId, 'listed', 'system', 'user', 1, 1, createdAt FROM docs
WHERE type = 'wiki' AND topicOf IS NULL AND authorKind = 'agent' AND authorId IN (SELECT managerAgentId FROM buildings WHERE managerAgentId IS NOT NULL);
INSERT OR IGNORE INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, seeded, createdAt)
SELECT 'sp_seed_' || id, id, 'town', NULL, 'listed', 'system', 'user', 1, 1, createdAt FROM docs
WHERE buildingId = 'town-hall' AND state != 'draft' AND tags LIKE '%"town-page"%';
