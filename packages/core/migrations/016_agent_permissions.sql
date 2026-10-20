-- v1.5 agent permissions: visitors (and human avatars) inherit their owner's permissions, capped by the owner; per-agent denies
ALTER TABLE agents ADD COLUMN inheritsOwner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN deniedPermissions TEXT NOT NULL DEFAULT '[]';
UPDATE agents SET inheritsOwner = 1 WHERE kind IN ('visitor', 'human');
