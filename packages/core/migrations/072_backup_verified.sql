-- Hourly verified backups (grant gr_ba0juhlm7n, deploy/README.md "Backups"): after each upload the job downloads the object
-- back, decrypts, gunzips and integrity_checks it; verifiedAt is when the last one passed (GET /api/health `backup.verifiedAt`).
ALTER TABLE backup_state ADD COLUMN verifiedAt TEXT;
