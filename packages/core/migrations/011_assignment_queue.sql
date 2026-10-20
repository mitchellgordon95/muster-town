-- assignment queue order (lower runs first) and retry lineage. Existing rows: position = createdAt as epoch ms.
ALTER TABLE assignments ADD COLUMN position REAL NOT NULL DEFAULT 0;
ALTER TABLE assignments ADD COLUMN fromAssignmentId TEXT;
UPDATE assignments SET position = CAST(ROUND((julianday(createdAt) - 2440587.5) * 86400000.0) AS INTEGER);
