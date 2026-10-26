-- Managers write key results too (Mitchell, 1:1 mt_ayi4y9ybyj, 2026-10-26): who wrote each one, who last edited its
-- words, and the meeting notes or reports it came from. Older key results were all written by a human (unknown: null).
ALTER TABLE key_results ADD COLUMN createdBy TEXT;
ALTER TABLE key_results ADD COLUMN editedBy TEXT;
ALTER TABLE key_results ADD COLUMN sourceDocIds TEXT NOT NULL DEFAULT '[]';
