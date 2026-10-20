-- one repo per collective: the first building workspace becomes the town's, and buildings that had one get code access
ALTER TABLE buildings ADD COLUMN codeAccess INTEGER NOT NULL DEFAULT 0;
UPDATE buildings SET codeAccess = 1 WHERE workspace IS NOT NULL AND workspace NOT IN ('', 'null');
UPDATE meta SET value = json_set(value, '$.workspace', json((SELECT workspace FROM buildings WHERE codeAccess = 1 ORDER BY rowid LIMIT 1)))
  WHERE key = 'town' AND json_extract(value, '$.workspace') IS NULL AND EXISTS (SELECT 1 FROM buildings WHERE codeAccess = 1);
