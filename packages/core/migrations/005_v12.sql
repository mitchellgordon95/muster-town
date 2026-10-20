-- v1.2: hub semantics (no awaiting-review status), reviewer review policy.
-- Role renames/permission fixes are data fixes done in TS (migrateRoles in src/migrate-roles.ts), run at every open.
UPDATE agents SET status = 'idle' WHERE status = 'awaiting-review';
UPDATE buildings SET reviewPolicy = 'reviewer' WHERE reviewPolicy = 'moderator';
