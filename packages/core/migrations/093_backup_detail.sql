-- Hosted collectives and transcripts in the hourly backup (Mitchell, mt_1vs893enaw): the last run's other copies
-- (hosted/hub/, hosted/<slug>/) and its transcript upload counts as JSON, shown on GET /api/health `backup`.
ALTER TABLE backup_state ADD COLUMN detail TEXT;
