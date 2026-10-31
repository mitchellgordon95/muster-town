-- The map's shape is a town-wide setting (town.mapLayout: fountain | tree | radial; 1:1 mt_q10xf3bkoq). A new collective
-- starts with "fountain" (the Town schema's default); a town that already exists keeps today's packed tree until an admin
-- or a goal owner picks another shape on the town map. Additive: one key in the stored town row.
UPDATE meta SET value = json_set(value, '$.mapLayout', 'tree') WHERE key = 'town' AND json_extract(value, '$.mapLayout') IS NULL;
